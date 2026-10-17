import { app, BrowserWindow, ipcMain } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainHarness } from './mainHarness.ts'

// This file is launched ONLY as an Electron main entry, never as a launcher.
// The separate Node supervisor spawns it once, enforces the deadline and watches
// the output route. There is no recursive Node/Electron detection or restart.
if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) throw new Error('Wrong listening-test runtime.')
const directory = process.argv[2]
const config = JSON.parse(readFileSync(join(directory, 'active.json'), 'utf8'))
app.setPath('userData', join(directory, 'profile'))
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('disable-background-timer-throttling')
let win: BrowserWindow | null = null
const h = mainHarness(config.connection, config.ffmpeg, {
  recordPcm: false,
  ...(config.scenario === 'quality' ? { segmentQuality: (seconds: number) => seconds >= 12 && seconds < 24 ? 'opus-64' as const : 'lossless' as const } : {}),
  deliver: (channel, value) => { if (win && !win.isDestroyed()) win.webContents.send(channel, value) }
})
let closing = false
async function close(code = 0) {
  if (closing) return
  closing = true
  win?.webContents.setAudioMuted(true)
  await h.close()
  app.exit(code)
}
process.on('SIGTERM', () => { void close() })
app.on('window-all-closed', () => { void close() })
setTimeout(() => { void close(1) }, 60000).unref()
ipcMain.handle('test:start', (_event, path, rate, channels, options) => h.startOptions(path, rate, channels,
  { ...options, streamingQuality: options?.streamingQuality ?? (path.endsWith('/second') ? 64 : 'original') }))
ipcMain.handle('test:cancel', (_event, id) => h.cancel(id))
ipcMain.handle('test:pending', (_event, slot) => h.registry.cancel(1, slot === 'next' ? 'next' : 'current'))
ipcMain.on('test:position', (_event, id, frame) => h.position(id, frame))
ipcMain.on('test:activate', (_event, id) => { const value = h.sessions.get(id); if (value) value.slot = 'current' })
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 620, height: 300, title: 'Astra · isolated Stratum listen',
    webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  win.webContents.on('render-process-gone', () => { void close(1) })
  await win.loadFile(join(directory, 'index.html'))
  const deadline = Date.now() + 20000
  let started = false
  while (!closing && win && !win.isDestroyed()) {
    const state = await win.webContents.executeJavaScript('window.testState')
    if (state?.error) throw new Error(state.error)
    if (state?.ready && !started) {
      // The supervisor is invoked with --play only after listening readiness.
      started = true
      await win.webContents.executeJavaScript('window.testPlay()')
      console.log('LISTENING_STARTED')
    }
    if (!started && Date.now() > deadline) throw new Error('Listening setup timed out.')
    if (state?.done) {
      writeFileSync(join(directory, 'listening-report.json'), JSON.stringify({ ...state,
        scenario: config.scenario ?? 'gapless', qualityEvents: h.qualityEvents,
        sessions: h.events.filter(event => event.type === 'complete' || event.type === 'failed') }, null, 2))
      console.log('LISTENING_FINISHED')
      await close()
      return
    }
    await delay(50)
  }
}).catch(error => {
  writeFileSync(join(directory, 'listening-error.txt'), String(error))
  console.error('Listening fixture failed; see its private error file.')
  void close(1)
})
