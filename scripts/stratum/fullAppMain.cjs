// Explicit Electron entry. Never spawns Electron; uses only its disposable profile.
const { app, ipcMain, session, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) throw new Error('This entry requires the Electron app runtime.')
const directory = path.resolve(process.argv[2])
const root = path.resolve(__dirname, '../..')
const active = JSON.parse(fs.readFileSync(path.join(directory, 'active.json'), 'utf8'))
const profile = fs.mkdtempSync(path.join(directory, 'profile-'))
app.setPath('userData', profile)
app.setAppPath(root)
app.setName('Astra Stratum Silent Check')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
Object.defineProperty(process, 'resourcesPath', { value: path.join(directory, 'resources') })
fs.writeFileSync(path.join(profile, 'desktop-integration.json'), JSON.stringify({ trayEnabled: false, closeToTray: false }))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const starts = [], errors = [], providerReports = [], pendingPerformance = new Set()
let closing = false, windowCount = 0, ran = false, targetWindow
const fetchOriginal = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) return Promise.reject(new Error('External network disabled in full-app fixture'))
  return fetchOriginal(input, init)
}
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, handler) => handle(channel, async (...args) => {
  if (channel === 'app:getPerformanceStats') {
    if (closing) return null
    const pending = Promise.resolve(handler(...args)); pendingPerformance.add(pending)
    try { return await pending } finally { pendingPerformance.delete(pending) }
  }
  const result = await handler(...args)
  if (channel === 'audio:startProgressiveStream') starts.push({ path: args[1], options: args[4],
    sessionId: result.sessionId, transport: result.transport ?? null, sourceType: result.sourceType, quality: result.quality })
  return result
})
ipcMain.on('provider-playback:observe', (_event, report) => providerReports.push(report))
globalThis.__stratumAppSeed = async (library, services) => {
  assert.equal(app.getPath('userData'), profile)
  assert.ok(safeStorage.isEncryptionAvailable(), 'Secure storage unavailable for disposable credential')
  for (const [index, name] of ['Stratum Fixture', 'Conventional Fixture'].entries()) {
    const source = await library.createSubsonicSource({ name, base_url: active.baseUrl, username: 'fixture',
      secret_encrypted: services.encryptSubsonicSecret(active.password), enabled: 1, last_status: 'connected' })
    assert.equal(source.id, index + 1)
    const catalog = await services.syncSubsonicCatalog(source.id, { baseUrl: active.baseUrl, username: 'fixture', password: active.password })
    assert.equal(catalog.tracks.length, 2)
    await library.upsertSubsonicTracks(source.id, catalog.tracks)
  }
  await library.addLibraryFolder(path.join(directory, 'music'))
  const scanned = await library.scanFolder(path.join(directory, 'music'))
  assert.equal(scanned.errors, 0)
  await library.setAppMeta('streaming_quality_v1', JSON.stringify({ global: 'automatic', overrides: {} }))
  console.log('DISPOSABLE_LIBRARY_READY')
}
app.whenReady().then(() => {
  // App startup installs permissive handlers; keep this synthetic run denied.
  const s = session.defaultSession
  const denyRequest = s.setPermissionRequestHandler.bind(s)
  const denyCheck = s.setPermissionCheckHandler.bind(s)
  s.setPermissionRequestHandler = () => denyRequest((_contents, _permission, callback) => callback(false))
  s.setPermissionCheckHandler = () => denyCheck(() => false)
  s.setPermissionRequestHandler(); s.setPermissionCheckHandler()
  s.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
})
async function finish(code, result) {
  if (closing) return
  closing = true
  fs.writeFileSync(path.join(directory, 'full-app-report.json'), JSON.stringify({ success: code === 0, result, starts, providerReports, errors, windowCount,
    profile, muted: targetWindow?.webContents.isAudioMuted() ?? true }, null, 2))
  if (targetWindow && !targetWindow.isDestroyed()) {
    await targetWindow.webContents.executeJavaScript('window.stratumFullApp?.stop()').catch(() => {})
    targetWindow.destroy()
  }
  await Promise.allSettled([...pendingPerformance])
  process.exitCode = code
  // Run normal application shutdown handlers (reporting, decoders, database).
  app.quit()
  setTimeout(() => app.exit(code), 3000).unref()
}
app.on('browser-window-created', (_event, win) => {
  windowCount++
  if (windowCount > 1) { win.destroy(); void finish(1, { error: 'Unexpected second window' }); return }
  targetWindow = win
  win.webContents.setAudioMuted(true)
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message.slice(0, 2000)) })
  win.webContents.on('render-process-gone', (_event, details) => { if (!closing) void finish(1, { error: `Renderer exited: ${details.reason}` }) })
  win.webContents.on('did-finish-load', async () => {
    if (ran) return
    ran = true
    try {
      for (let i = 0; i < 100; i++) {
        if (await win.webContents.executeJavaScript('Boolean(window.stratumFullApp)')) break
        await pause(100)
      }
      console.log('FULL_APP_SILENT_CHECK_STARTED')
      let lastPhase = ''
      const progress = setInterval(async () => {
        if (closing || win.isDestroyed()) return
        const current = await win.webContents.executeJavaScript('window.stratumFullApp?.snapshot().phase').catch(() => null)
        if (current && current !== lastPhase) { console.log('FULL_APP_PHASE', current); lastPhase = current }
      }, 1000)
      let result
      try { result = await win.webContents.executeJavaScript(`window.stratumFullApp.run(${JSON.stringify({ directory })})`, true) }
      finally { clearInterval(progress) }
      assert.equal(windowCount, 1)
      assert.ok(win.webContents.isAudioMuted())
      const stratum = starts.filter(start => start.path.startsWith('subsonic://1/'))
      assert.ok(stratum.length > 0 && stratum.every(start => start.transport === 'stratum-proof'), 'Allowlisted catalog paths must use Stratum')
      assert.ok(starts.some(start => start.path.startsWith('subsonic://2/') && start.transport === null), 'Other source must remain conventional')
      assert.ok(providerReports.some(report => report.path?.startsWith('subsonic://1/') || report.trackPath?.startsWith('subsonic://1/')), 'Stratum must retain provider reporting')
      assert.deepEqual(errors, [], 'Renderer must complete without console errors')
      fs.writeFileSync(path.join(directory, 'full-app.png'), (await win.webContents.capturePage()).toPNG())
      await finish(0, result)
    } catch (error) {
      const debug = await win.webContents.executeJavaScript('window.stratumFullApp?.snapshot()').catch(() => null)
      console.error('FULL_APP_FAILED', String(error))
      await finish(1, { error: String(error), debug })
    }
  })
})
setTimeout(() => { void finish(2, { error: 'Full-app deadline exceeded' }) }, 160000).unref()
process.on('uncaughtException', error => { console.error(String(error)); void finish(1, { error: String(error) }) })
require(path.join(directory, 'app/main/index.js'))
