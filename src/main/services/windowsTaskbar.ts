import type { BrowserWindow, NativeImage, NativeTheme, ThumbarButton } from 'electron'
import type { MiniPlayerCommand, MiniPlayerSnapshot } from '../../types/miniPlayer'

export type TaskbarIcon = 'favorite' | 'favorited' | 'previous' | 'play' | 'pause' | 'next'

interface WindowsTaskbarOptions {
  window: BrowserWindow
  theme: NativeTheme
  loadIcon: (name: TaskbarIcon, dark: boolean) => NativeImage
  sendCommand: (command: MiniPlayerCommand) => void
}

// Install only on Windows. Keep this independent of whether the notification tray is enabled.
export function installWindowsTaskbarControls({ window, theme, loadIcon, sendCommand }: WindowsTaskbarOptions) {
  let snapshot: MiniPlayerSnapshot | null = null
  let rendererReady = false
  let windowReady = false
  let lastStateKey: string | null = null
  const icons = new Map<string, NativeImage>()

  const canControl = () => rendererReady && snapshot?.currentTrack != null
    && !window.isDestroyed() && !window.webContents.isDestroyed()

  function refresh(force = false): void {
    if (!windowReady || window.isDestroyed()) return
    const enabled = canControl()
    const playing = snapshot?.playbackState === 'playing' || snapshot?.playbackState === 'loading'
    const favorite = snapshot?.currentTrack?.isFavorite === true
    const dark = theme.shouldUseDarkColorsForSystemIntegratedUI
    const stateKey = JSON.stringify([enabled, playing, favorite, dark])
    // Playback snapshots include the clock; only touch the native toolbar when its state changes.
    if (!force && lastStateKey === stateKey) return

    const button = (name: TaskbarIcon, tooltip: string, command: MiniPlayerCommand): ThumbarButton => {
      const iconKey = `${dark}:${name}`
      let icon = icons.get(iconKey)
      if (!icon) {
        icon = loadIcon(name, dark)
        icons.set(iconKey, icon)
      }
      return {
        icon,
        tooltip,
        // Enabled is the native default. Electron's Windows parser rejects an explicit 'enabled' flag.
        flags: enabled ? [] : ['disabled'],
        click: () => {
          if (canControl()) sendCommand(command)
        },
      }
    }

    const buttons = [
      button(favorite ? 'favorited' : 'favorite', favorite ? 'Remove from favorites' : 'Add to favorites', { type: 'toggleFavoriteCurrent' }),
      button('previous', 'Previous', { type: 'playPrevious' }),
      button(playing ? 'pause' : 'play', playing ? 'Pause' : 'Play', { type: 'togglePlay' }),
      button('next', 'Next', { type: 'playNext' }),
    ]
    // Windows can reject the first update before its taskbar button exists. Leave it retryable.
    if (window.setThumbarButtons(buttons)) lastStateKey = stateKey
  }

  function invalidateRenderer(): void {
    rendererReady = false
    snapshot = null
    refresh()
  }

  window.once('ready-to-show', () => {
    windowReady = true
    refresh()
  })
  window.on('show', () => refresh(true))
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) invalidateRenderer()
  })
  window.webContents.on('render-process-gone', invalidateRenderer)
  const onThemeUpdated = () => refresh()
  theme.on('updated', onThemeUpdated)
  window.once('closed', () => {
    theme.removeListener('updated', onThemeUpdated)
    icons.clear()
  })

  return {
    publishSnapshot(next: MiniPlayerSnapshot): void {
      snapshot = next
      refresh()
    },
    setRendererReady(ready: boolean): void {
      rendererReady = ready
      refresh()
    },
  }
}
