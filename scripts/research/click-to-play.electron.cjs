// Launch using the repository's Electron binary. Every invocation owns a fresh,
// disposable profile; the user's application, database and cache are never opened.
const { app, ipcMain, session } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '../..')
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (fs.existsSync(path.join(path.dirname(config.output), 'STOP'))) process.exit(3)
// Supply the packaged resource layout without changing Electron's installation.
const resources = path.join(root, '.astra-playback-benchmark/resources')
fs.mkdirSync(resources, { recursive: true })
for (const [name, target] of [['native', 'native/build/Release'], ['hrtf', 'resources/hrtf'], ['tray', 'resources/tray']]) {
  const link = path.join(resources, name)
  if (!fs.existsSync(link)) fs.symlinkSync(path.join(root, target), link, 'dir')
}
Object.defineProperty(process, 'resourcesPath', { value: resources })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-playback-benchmark-'))
app.setPath('userData', profile)
app.setAppPath(root)
app.setName('Astra Playback Benchmark')
const events = []
const loudnessRequests = []
const binaryProbes = []
if (config.binaryTrace) {
  const childProcess = require('node:child_process')
  const execFile = childProcess.execFile
  childProcess.execFile = function (file, args, ...rest) {
    if (args?.includes('-version')) binaryProbes.push({ file, startedAt: performance.now() })
    return execFile.call(this, file, args, ...rest)
  }
}
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, handler) => originalHandle(channel, async (...args) => {
  if (channel === 'diagnostics:logEvent' && args[1]?.name === 'playback_attempt_completed') {
    events.push({ ...args[1].details, diagnosticOptions: args[2] })
  }
  if (channel === 'audio:analyzeTrackLoudness') {
    const startedAt = performance.now()
    const result = await handler(...args)
    loudnessRequests.push({ path: args[1], durationMs: performance.now() - startedAt, source: result?.source ?? null })
    return result
  }
  return handler(...args)
})
let started = false
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
})
app.on('browser-window-created', (_event, win) => {
  win.webContents.setAudioMuted(true)
  win.webContents.on('did-finish-load', async () => {
    if (started || !win.webContents.getURL().includes('renderer/index.html')) return
    started = true
    try {
      for (let i = 0; i < 100; i++) {
        if (await win.webContents.executeJavaScript('Boolean(window.astraPlaybackBenchmark)')) break
        await pause(100)
      }
      // Allow normal app startup effects to settle, without starting playback.
      await pause(1000)
      if (config.outputMode) {
        const result = await win.webContents.executeJavaScript(`window.astraPlaybackBenchmark.compatibility(${JSON.stringify(config)})`, true)
        fs.writeFileSync(config.output, JSON.stringify({ config, result }, null, 2))
        app.exit(0)
        return
      }
      const db = new (require('better-sqlite3'))(path.join(profile, 'library.db'))
      if (config.normalization === 'cached') {
        await win.webContents.executeJavaScript(`window.electronAPI.analyzeTrackLoudness(${JSON.stringify(config.path)})`)
        if (config.alternatePath) await win.webContents.executeJavaScript(`window.electronAPI.analyzeTrackLoudness(${JSON.stringify(config.alternatePath)})`)
      }
      await win.webContents.executeJavaScript(`window.astraPlaybackBenchmark.setup(${JSON.stringify(config)})`)
      const capabilities = await win.webContents.executeJavaScript('window.nativeAudioAPI.getCapabilities()')
      const samples = []
      for (let i = 0; i <= (config.warmClicks ?? 20); i++) {
        if (config.normalization === 'uncached') db.prepare('DELETE FROM track_loudness').run()
        events.length = 0
        loudnessRequests.length = 0
        const sample = await win.webContents.executeJavaScript('window.astraPlaybackBenchmark.click()', true)
        await pause(100)
        const attempt = events.find((event) => event.outcome === 'loaded') ?? events[0] ?? null
        if (!config.controlled && (sample.state !== 'playing' || attempt?.outcome !== 'loaded' || attempt.backend !== 'standard')) {
          throw new Error(`Unexpected playback outcome: ${JSON.stringify({ sample, attempt })}`)
        }
        samples.push({ kind: i === 0 ? 'cold' : 'warm', ...sample, loudnessRequests: [...loudnessRequests], attempt })
      }
      db.close()
      fs.writeFileSync(config.output, JSON.stringify({ config, profile, capabilities, binaryProbes, hardware: { cpu: os.cpus()[0].model, cpus: os.cpus().length, memory: os.totalmem(), platform: os.platform(), release: os.release(), arch: os.arch(), versions: process.versions }, samples }, null, 2))
      app.exit(0)
    } catch (error) {
      console.error('PLAYBACK BENCHMARK FAILED', error)
      app.exit(1)
    }
  })
})
setTimeout(() => { console.error('PLAYBACK BENCHMARK TIMEOUT'); app.exit(2) }, 300000).unref()
require(path.resolve(root, '.astra-playback-benchmark', config.build, 'main/index.js'))
