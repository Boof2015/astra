// Run after npm run build: electron scripts/research/notch.electron.cjs
// Uses disposable preferences and playback fixtures; never opens the user's library.
const { app, BrowserWindow, ipcMain } = require('electron')
const { buildSync } = require('esbuild')
const { join } = require('node:path')
const { mkdtempSync, writeFileSync, mkdirSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const root = join(__dirname, '../..')
process.env.NODE_ENV = 'development'
// Keep the lock separate from disposable playback data so a second fixture
// cannot leave two independently animated panels stacked over the same notch.
if (!process.argv.includes('--app')) {
  const lockPath = join(tmpdir(), 'astra-notch-qa-lock')
  mkdirSync(lockPath, { recursive: true })
  app.setPath('userData', lockPath)
  if (!app.requestSingleInstanceLock()) {
    console.error('A notch fixture is already running. Close it before launching another build.')
    app.exit(0)
    return
  }
}
const userData = mkdtempSync(join(tmpdir(), 'astra-notch-qa-'))
app.setPath('userData', userData)
const output = '/private/tmp/astra-notch-qa'
mkdirSync(output, { recursive: true })
buildSync({ entryPoints: [join(root, 'src/main/services/notchController.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(root, 'out/main/notch-qa-controller.cjs') })
const { NotchController } = require(join(root, 'out/main/notch-qa-controller.cjs'))
let controller, main, track = 1, fixtureArtwork = null
let fixtureSamples = null, fixtureSampleIndex = 0
const pcmIndex = process.argv.indexOf('--pcm-file')
if (pcmIndex !== -1 && process.argv[pcmIndex + 1]) {
  // Optional 48 kHz mono f32le samples; silent analysis, never audio playback.
  const bytes = readFileSync(process.argv[pcmIndex + 1])
  fixtureSamples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}
const snapshot = {
  playbackState: 'paused', currentTime: 72, duration: 258, queueLength: 3, shuffle: false, repeat: 'none',
  volume: 0.6, isMuted: false, outputDeviceLabel: 'QA output', timeDisplayMode: 'remaining', visualizerLineColor: '#38bdf8',
  currentTrack: { id: '1', path: 'qa:1', title: 'An Ending (Ascent)', artist: 'Brian Eno', album: 'Apollo', isFavorite: false, artworkData: null },
}
function command(command) {
  console.log('COMMAND', JSON.stringify(command))
  if (command.type === 'togglePlay') snapshot.playbackState = snapshot.playbackState === 'playing' ? 'paused' : 'playing'
  if (command.type === 'toggleMute') snapshot.isMuted = !snapshot.isMuted
  if (command.type === 'playNext' || command.type === 'playPrevious') {
    track += 1
    snapshot.currentTrack = { ...snapshot.currentTrack, id: String(track), path: `qa:${track}`, title: track % 2 ? 'An Ending (Ascent)' : 'A very long song title that should truncate cleanly in this small playback surface', artist: track % 2 ? 'Brian Eno' : 'An artist with a deliberately long name to verify truncation' }
    snapshot.playbackState = 'playing'
    if (!snapshot.duration) snapshot.duration = 258
  }
  if (command.type === 'toggleFavoriteCurrent' && snapshot.currentTrack) snapshot.currentTrack.artworkData = snapshot.currentTrack.artworkData ? null : fixtureArtwork
  if (command.type === 'pause') { snapshot.currentTrack = null; snapshot.currentTime = 0; snapshot.duration = 0; snapshot.playbackState = 'paused' }
  if (command.type === 'seek') snapshot.currentTime = command.time
  if (command.type === 'setVolume') { snapshot.volume = command.volume; snapshot.isMuted = false }
  if (command.type === 'toggleRepeat') main.setFullScreen(!main.isFullScreen())
  if (command.type === 'toggleShuffle') void controller.window?.webContents.executeJavaScript('electronAPI.notch.expand()')
  controller.publishSnapshot(snapshot)
}
if (process.argv.includes('--app')) {
  console.log('QA_APP_PROFILE', userData)
  require(join(root, 'out/main/index.js'))
} else app.whenReady().then(async () => {
  const trackFileIndex = process.argv.indexOf('--track-file')
  if (trackFileIndex !== -1 && process.argv[trackFileIndex + 1]) {
    const { parseFile, selectCover } = await import('music-metadata')
    const metadata = await parseFile(process.argv[trackFileIndex + 1])
    const picture = selectCover(metadata.common.picture)
    fixtureArtwork = picture ? `data:${picture.format};base64,${Buffer.from(picture.data).toString('base64')}` : null
    snapshot.currentTrack = { ...snapshot.currentTrack, title: metadata.common.title || 'Untitled',
      artist: metadata.common.artists?.join(' · ') || metadata.common.artist || '', album: metadata.common.album || '', artworkData: fixtureArtwork }
    snapshot.duration = metadata.format.duration || 258
  }
  main = new BrowserWindow({ x: 470, y: 33, width: 600, height: 600, title: 'Astra Notch QA', webPreferences: { preload: join(root, 'out/preload/index.js'), sandbox: false, contextIsolation: true } })
  controller = new NotchController({
    getMainWindow: () => main,
    openAstra: () => { main.show(); main.focus(); console.log('OPEN_ASTRA') },
    sendCommand: command,
    preload: join(root, 'out/preload/index.js'), rendererFile: join(root, 'out/renderer/index.html'),
  })
  await controller.initialize()
  const start = controller.addon.start
  controller.addon.start = callback => start(pointer => { console.log('POINTER', JSON.stringify(pointer)); callback(pointer) })
  ipcMain.on('mini-player:sendCommand', (_, value) => command(value))
  const html = join(userData, 'qa.html')
  writeFileSync(html, `<!doctype html><html><body style="margin:0;background:#e5e9ed;font:15px system-ui;color:#172331">
    <div id="clicks" style="height:170px;padding:16px;border-bottom:1px solid #b5bdc7">Click-through test area. Clicks received: 0</div>
    <main style="padding:24px"><h2>Astra Notch QA</h2><p>Disposable playback fixtures. Hover beneath the physical notch, then click the preview.</p>
    <button onclick="prefs({enabled:true,restingView:'hidden'})">Hidden</button>
    <button onclick="prefs({enabled:true,restingView:'metadata'})">Metadata</button>
    <button onclick="prefs({enabled:true,restingView:'oscilloscope'})">Oscilloscope</button>
    <button onclick="prefs({enabled:true,restingView:'spectrum'})">Spectrum</button>
    <button onclick="prefs({enabled:false})">Disable</button><hr>
    <button onclick="electronAPI.miniPlayer.sendCommand({type:'toggleShuffle'})">Expand notch</button>
    <button onclick="electronAPI.miniPlayer.sendCommand({type:'playNext'})">Next track</button>
    <button onclick="electronAPI.miniPlayer.sendCommand({type:'togglePlay'})">Play / pause</button>
    <button onclick="electronAPI.miniPlayer.sendCommand({type:'toggleFavoriteCurrent'})">Toggle artwork</button>
    <button onclick="electronAPI.miniPlayer.sendCommand({type:'pause'})">Empty track</button>
    <button onclick="electronAPI.miniPlayer.sendCommand({type:'toggleRepeat'})">Fullscreen host</button>
    <button onclick="prefs({showOverFullscreen:!current.prefs.showOverFullscreen})">Toggle fullscreen visibility</button>
    <pre id="status" style="font-size:11px;white-space:pre-wrap"></pre></main>
    <script>let current;const prefs=p=>electronAPI.notch.setPrefs(p);let clicks=0;document.querySelector('#clicks').onclick=()=>document.querySelector('#clicks').textContent='Click-through test area. Clicks received: '+(++clicks);
    electronAPI.notch.onState(s=>{current=s;document.querySelector('#status').textContent=JSON.stringify(s,null,2)});electronAPI.notch.getState().then(s=>current=s);</script></body></html>`)
  await main.loadFile(html)
  controller.publishSnapshot(snapshot)
  await main.webContents.executeJavaScript('electronAPI.notch.setPrefs({enabled:true,restingView:"hidden"})')
  main.on('closed', () => { main = null; controller.dispose(); app.quit() })
  console.log('QA_READY', JSON.stringify({ userData, output }))
  if (process.argv.includes('--native-motion-check')) {
    try {
      await require('./notch-native-motion-check.cjs')({ controller, main, output })
      app.quit()
    } catch (error) { console.error(error); app.exit(1) }
    return
  }
  let last = ''
  let tracing = false
  const timer = setInterval(async () => {
    const state = controller.state
    const key = JSON.stringify(state)
    if (key !== last) {
      last = key
      const window = controller.window
      console.log('STATE', JSON.stringify({ ...state, bounds: window?.getBounds(), focused: window?.isFocused() }))
      console.log('NATIVE', JSON.stringify(controller.addon.getDiagnostics()))
      if (process.argv.includes('--motion-trace') && state.view === 'peek' && window && !tracing) {
        tracing = true
        void window.webContents.executeJavaScript(`new Promise(resolve => {
          const frames = [], start = performance.now();
          const sample = () => {
            const el = document.querySelector('.notch-surface'), style = getComputedStyle(el), rect = el.getBoundingClientRect();
            frames.push({ ms: Math.round(performance.now() - start), topWidth: Number(style.getPropertyValue('--notch-top-width')),
              bottomWidth: Number(style.getPropertyValue('--notch-bottom-width')), height: Number(style.getPropertyValue('--notch-surface-height')),
              clip: style.clipPath, opacity: Number(style.opacity), content: Number(style.getPropertyValue('--notch-content-opacity')) });
            if (performance.now() - start < 650) requestAnimationFrame(sample); else resolve(frames);
          }; sample();
        })`).then(frames => {
          writeFileSync(join(output, 'reveal-trace.json'), JSON.stringify(frames, null, 2))
          console.log('MOTION_TRACE', JSON.stringify(frames.filter((_, i) => i % 4 === 0).map(({ clip, ...frame }) => frame)))
        })
      }
      if (window && state.attached) {
        setTimeout(async () => {
          if (window.isDestroyed() || controller.state.view !== state.view) return
          const screenshot = await window.webContents.capturePage()
          writeFileSync(join(output, `${state.view}.png`), screenshot.toPNG())
          const layout = await window.webContents.executeJavaScript(`({
            surface: document.querySelector('.notch-surface').getBoundingClientRect().toJSON(),
            preview: document.querySelector('.notch-preview').getBoundingClientRect().toJSON(),
            scope: document.querySelector('.notch-scope')?.getBoundingClientRect().toJSON(),
            player: document.querySelector('.notch-player').getBoundingClientRect().toJSON(),
            footer: document.querySelector('.notch-player footer').getBoundingClientRect().toJSON(),
            artwork: document.querySelector('.notch-art').getBoundingClientRect().toJSON(),
            seek: document.querySelector('.notch-seek').getBoundingClientRect().toJSON(),
            focusedElement: document.activeElement?.getAttribute('aria-label'),
            contour: ['--notch-top-width', '--notch-bottom-width', '--notch-surface-height'].map(key => getComputedStyle(document.querySelector('.notch-surface')).getPropertyValue(key)),
          })`)
          console.log('LAYOUT', JSON.stringify({ detectedWidth: controller.state.notchWidth, ...layout, native: controller.addon.getDiagnostics() }))
          const resources = await window.webContents.executeJavaScript('performance.getEntriesByType("resource").map(r=>r.name).filter(n=>/App-|AudioEngine/.test(n))')
          console.log('ISOLATION', JSON.stringify(resources))
        }, state.view === 'peek' ? 70 : 350)
      }
    }
    if (snapshot.playbackState === 'playing' && state.visualizerMode !== 'off') {
      const samples = Float32Array.from({ length: 1200 }, (_, i) => fixtureSamples?.length
        ? fixtureSamples[(fixtureSampleIndex + i) % fixtureSamples.length]
        : Math.sin((fixtureSampleIndex + i) * 2 * Math.PI * 220 / 48000) * 0.5)
      fixtureSampleIndex += samples.length
      controller.publishVisualizerChunk({ capturedAt: Date.now(), sampleRate: 48000, leftChunks: [samples], monoChunks: [samples], fftSize: 4096, pitchLock: true, oscilloscopeUnderfillEnabled: false, lineColor: '#38bdf8', reset: false })
    }
  }, 25)
  app.on('before-quit', () => { clearInterval(timer); controller.dispose() })
})
