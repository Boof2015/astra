import { app, BrowserWindow, ipcMain, powerMonitor, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import type { MiniPlayerCommand, MiniPlayerSnapshot, MiniPlayerVisualizerStreamChunk } from '../../types/miniPlayer'
import { DEFAULT_NOTCH_PREFS, NOTCH_SIZE, type NotchGeometry, type NotchPointer, type NotchPrefs, type NotchRuntimeState, type NotchSurfaceBounds } from '../../types/notch'
import { NotchInteraction, normalizeNotchPrefs } from './notchState'
import { loadNotchPrefs, saveNotchPrefs } from './notchPrefs'

interface NativeNotch {
  getGeometry(): NotchGeometry | null
  configure(handle: Buffer, geometry: NotchGeometry, fullscreen: boolean): void
  setSurface(bounds: NotchSurfaceBounds): void
  start(callback: (pointer: NotchPointer) => void): void
  stop(): void
}
interface Options {
  getMainWindow(): BrowserWindow | null
  openAstra(): void
  sendCommand(command: MiniPlayerCommand): void
  preload: string
  rendererFile: string
  rendererUrl?: string
}

export class NotchController {
  private options: Options
  private prefs: NotchPrefs = { ...DEFAULT_NOTCH_PREFS }
  private interaction = new NotchInteraction(this.prefs)
  private addon: NativeNotch | null = null
  private geometry: NotchGeometry | null = null
  private window: BrowserWindow | null = null
  private observedMainWindow: BrowserWindow | null = null
  private snapshot: MiniPlayerSnapshot | null = null
  private availability: NotchRuntimeState['availability'] = 'unsupported'
  private error: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private listening = false
  private ready = false
  private onActiveSpace = false
  private sleeping = false
  private disposed = false
  private reducedMotion = false
  private lastState = ''
  private writes: Promise<unknown> = Promise.resolve()

  constructor(options: Options) { this.options = options; this.registerIpc() }
  private get path(): string { return join(app.getPath('userData'), 'notch-integration.json') }

  async initialize(): Promise<void> {
    this.prefs = await loadNotchPrefs(this.path)
    this.interaction.configure(this.prefs)
    if (process.platform === 'darwin') {
      try {
        const path = app.isPackaged ? join(process.resourcesPath, 'native/macos_notch.node')
          : join(__dirname, '../../native/build/Release/macos_notch.node')
        this.addon = require(path) as NativeNotch
        this.availability = 'no-notch'
      } catch (error) {
        this.availability = 'unavailable'
        this.error = 'Notch support could not load. Rebuild the macOS native module or reinstall Astra.'
        console.warn('[notch] Native module unavailable:', error)
      }
    }
    this.reconcile()
  }

  get state(): NotchRuntimeState {
    const attached = this.window !== null && this.ready
    const presentation = attached && this.onActiveSpace ? this.interaction.presentation : { view: 'hidden' as const, reason: 'resting' as const }
    const visualizerMode = !this.reducedMotion && (presentation.view === 'oscilloscope' || presentation.view === 'spectrum')
      ? presentation.view : 'off'
    return {
      prefs: this.prefs, availability: this.availability, error: this.error, attached,
      notchWidth: this.geometry?.width ?? null, notchHeight: this.geometry?.height ?? null,
      proximity: attached && this.onActiveSpace ? this.interaction.proximity : 0,
      ...presentation, visualizerMode,
    }
  }

  private publish = (): void => {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.syncMainWindowForeground()
    const now = Date.now()
    this.interaction.tick(now)
    const state = this.state
    const key = JSON.stringify(state)
    if (key !== this.lastState) {
      this.lastState = key
      this.options.getMainWindow()?.webContents.send('notch:state', state)
      this.window?.webContents.send('notch:state', state)
    }
    const deadline = this.interaction.deadline
    if (this.window && deadline !== null) this.timer = setTimeout(this.publish, Math.max(1, deadline - now))
  }

  publishSnapshot(snapshot: MiniPlayerSnapshot): void {
    this.syncMainWindowForeground()
    this.snapshot = snapshot
    this.interaction.snapshot(snapshot, Date.now(), this.ready && this.onActiveSpace)
    this.window?.webContents.send('notch:snapshot', snapshot)
    this.publish()
  }
  publishVisualizerChunk(chunk: MiniPlayerVisualizerStreamChunk): void {
    if (this.state.visualizerMode !== 'off') this.window?.webContents.send('notch:visualizerChunk', chunk)
  }

  private closeWindow(): void {
    this.addon?.stop()
    this.ready = false
    this.onActiveSpace = false
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    const window = this.window
    this.window = null
    if (window && !window.isDestroyed()) window.destroy()
    this.interaction = new NotchInteraction(this.prefs)
    if (this.snapshot) this.interaction.snapshot(this.snapshot, Date.now())
    this.publish()
  }

  private onSuspend = (): void => { this.sleeping = true; this.closeWindow() }
  private onResume = (): void => { this.sleeping = false; this.reconcile() }
  private onDisplay = (): void => { this.closeWindow(); this.reconcile() }

  private syncMainWindowForeground(): void {
    const main = this.options.getMainWindow()
    this.interaction.setMainWindowForeground(Boolean(main && !main.isDestroyed()
      && main.isVisible() && !main.isMinimized() && main.isFocused()))
  }
  private onMainWindowActivity = (): void => {
    this.publish()
  }
  private observeMainWindow(window: BrowserWindow | null): void {
    if (window !== this.observedMainWindow) {
      this.observedMainWindow
        ?.removeListener('focus', this.onMainWindowActivity)
        .removeListener('blur', this.onMainWindowActivity)
        .removeListener('show', this.onMainWindowActivity)
        .removeListener('hide', this.onMainWindowActivity)
        .removeListener('minimize', this.onMainWindowActivity)
        .removeListener('restore', this.onMainWindowActivity)
      this.observedMainWindow = window
      window?.on('focus', this.onMainWindowActivity)
        .on('blur', this.onMainWindowActivity)
        .on('show', this.onMainWindowActivity)
        .on('hide', this.onMainWindowActivity)
        .on('minimize', this.onMainWindowActivity)
        .on('restore', this.onMainWindowActivity)
    }
    this.syncMainWindowForeground()
  }

  private observeDisplays(enabled: boolean): void {
    if (enabled === this.listening) return
    this.listening = enabled
    const method = enabled ? 'on' : 'removeListener'
    screen[method]('display-added', this.onDisplay)
    screen[method]('display-removed', this.onDisplay)
    screen[method]('display-metrics-changed', this.onDisplay)
    powerMonitor[method]('suspend', this.onSuspend)
    powerMonitor[method]('resume', this.onResume)
    powerMonitor[method]('lock-screen', this.onSuspend)
    powerMonitor[method]('unlock-screen', this.onResume)
  }

  reconcile(): void {
    if (this.disposed) return
    this.observeMainWindow(this.prefs.enabled && this.addon ? this.options.getMainWindow() : null)
    this.observeDisplays(this.prefs.enabled && this.addon !== null)
    if (this.addon) {
      this.geometry = this.addon.getGeometry()
      this.availability = this.geometry ? 'available' : 'no-notch'
    }
    if (!this.prefs.enabled || !this.geometry || !this.addon || this.sleeping || !this.options.getMainWindow()) {
      this.closeWindow()
      return
    }
    if (this.window) { this.publish(); return }
    const window = new BrowserWindow({
      width: NOTCH_SIZE.width, height: NOTCH_SIZE.backingHeight + this.geometry.height,
      title: 'Astra Notch', type: 'panel', frame: false, transparent: true,
      backgroundColor: '#00000000', show: false, hasShadow: false, roundedCorners: false,
      // Electron otherwise constrains even native frame updates below the menu bar.
      enableLargerThanScreen: true,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, hiddenInMissionControl: true, acceptFirstMouse: true,
      webPreferences: { preload: this.options.preload, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
    })
    this.window = window
    window.on('page-title-updated', event => { event.preventDefault(); window.setTitle('Astra Notch') })
    window.setIgnoreMouseEvents(true)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); this.collapse() }
    })
    window.webContents.on('render-process-gone', () => {
      if (this.window !== window) return
      this.error = 'The notch view stopped. Toggle Notch Integration to reopen it.'
      this.closeWindow()
    })
    window.on('closed', () => {
      if (this.window === window) { this.window = null; this.addon?.stop(); this.ready = false; this.publish() }
    })
    const loading = this.options.rendererUrl
      ? window.loadURL(`${this.options.rendererUrl}?window=notch`)
      : window.loadFile(this.options.rendererFile, { query: { window: 'notch' } })
    void loading.catch(error => {
      console.warn('[notch] Load failed:', error)
      if (this.window === window) this.closeWindow()
    })
  }

  mainWindowClosed(): void { this.observeMainWindow(null); this.snapshot = null; this.closeWindow() }
  dispose(): void { this.disposed = true; this.observeMainWindow(null); this.observeDisplays(false); this.closeWindow() }

  private collapse(): void {
    this.interaction.collapse()
    this.releaseFocus()
    this.publish()
  }
  private releaseFocus(): void {
    // An outside click or Open Astra may already have transferred focus.
    // Blurring again would unnecessarily reorder the native panel.
    if (this.window?.isFocused()) this.window.blur()
  }
  private allowed(event: IpcMainEvent | IpcMainInvokeEvent, source: 'main' | 'notch' | 'either'): boolean {
    return (source !== 'notch' && event.sender === this.options.getMainWindow()?.webContents)
      || (source !== 'main' && event.sender === this.window?.webContents)
  }
  private registerIpc(): void {
    ipcMain.handle('notch:getState', event => {
      if (!this.allowed(event, 'either')) throw new Error('Invalid notch sender')
      return this.state
    })
    ipcMain.handle('notch:getSnapshot', event => this.allowed(event, 'notch') ? this.snapshot : null)
    ipcMain.handle('notch:setPrefs', (event, patch: unknown) => {
      if (!this.allowed(event, 'main')) throw new Error('Invalid notch sender')
      const operation = this.writes.catch(() => {}).then(async () => {
        const next = normalizeNotchPrefs({ ...this.prefs, ...(patch && typeof patch === 'object' ? patch : {}) })
        await saveNotchPrefs(this.path, next)
        const recreate = next.showOverFullscreen !== this.prefs.showOverFullscreen
        this.prefs = next; this.interaction.configure(next); this.error = this.addon ? null : this.error
        if (recreate) this.closeWindow()
        this.reconcile()
        return this.state
      })
      this.writes = operation
      return operation
    })
    ipcMain.on('notch:ready', event => {
      if (!this.allowed(event, 'notch') || !this.window || !this.geometry || !this.addon) return
      this.addon.stop()
      this.window.showInactive()
      this.addon.configure(this.window.getNativeWindowHandle(), this.geometry, this.prefs.showOverFullscreen)
      this.ready = true
      this.addon.start(pointer => {
        if (!this.window) return
        const wasExpanded = this.interaction.presentation.view === 'expanded'
        this.onActiveSpace = pointer.onActiveSpace
        if (!pointer.onActiveSpace) this.interaction.collapse()
        this.interaction.pointer(pointer, Date.now())
        if (wasExpanded && this.interaction.presentation.view !== 'expanded') this.releaseFocus()
        this.publish()
      })
      this.lastState = ''; this.publish()
      if (this.snapshot) this.window.webContents.send('notch:snapshot', this.snapshot)
    })
    ipcMain.on('notch:surface', (event, bounds: NotchSurfaceBounds) => {
      if (!this.allowed(event, 'notch') || !bounds || typeof bounds !== 'object') return
      if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return
      if (bounds.x < 0 || bounds.y < 0 || bounds.width < 0 || bounds.height < 0 ||
        bounds.x + bounds.width > NOTCH_SIZE.width + 1 || bounds.y + bounds.height > NOTCH_SIZE.backingHeight + (this.geometry?.height ?? 0) + 1) return
      if (!Array.isArray(bounds.points) || bounds.points.length > 64 ||
        (bounds.points.length < 3 && (bounds.width > 0 || bounds.height > 0))) return
      if (!bounds.points.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
        point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height)) return
      this.addon?.setSurface(bounds)
    })
    ipcMain.on('notch:reducedMotion', (event, reduced: unknown) => {
      if (!this.allowed(event, 'notch') || typeof reduced !== 'boolean') return
      this.reducedMotion = reduced; this.publish()
    })
    ipcMain.on('notch:expand', event => {
      if (!this.allowed(event, 'notch')) return
      this.interaction.expand(); this.window?.focus(); this.publish()
    })
    ipcMain.on('notch:collapse', event => { if (this.allowed(event, 'notch')) this.collapse() })
    ipcMain.on('notch:openAstra', event => {
      if (!this.allowed(event, 'notch')) return
      // Release the panel before requesting main-window focus: Electron's
      // native blur can otherwise undo that focus transfer. Publish only after
      // opening Astra so automatic resting content does not flash in between.
      this.releaseFocus()
      this.options.openAstra(); this.syncMainWindowForeground()
      this.interaction.collapse(); this.publish()
    })
    ipcMain.on('notch:command', (event, command: MiniPlayerCommand) => {
      if (!this.allowed(event, 'notch') || !command || typeof command !== 'object') return
      if (['togglePlay', 'toggleMute', 'playNext', 'playPrevious'].includes(command.type)) this.options.sendCommand({ type: command.type } as MiniPlayerCommand)
      else if (command.type === 'seek' && Number.isFinite(command.time)) this.options.sendCommand({ type: 'seek', time: Math.max(0, Math.min(this.snapshot?.duration ?? 0, command.time)) })
      else if (command.type === 'setVolume' && Number.isFinite(command.volume)) this.options.sendCommand({ type: 'setVolume', volume: Math.max(0, Math.min(1, command.volume)) })
    })
  }
}
