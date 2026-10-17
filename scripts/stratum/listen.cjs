// Node supervisor. Preparation/checking never launch Electron. --play is a
// separate, explicit action after listening readiness; exactly one child app.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createServer } = require('node:http')
const { randomBytes } = require('node:crypto')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const { build } = require('esbuild')
const assert = require('node:assert/strict')
if (process.versions.electron) throw new Error('Run this supervisor with Node, never Electron.')
const [mode, directory] = process.argv.slice(2)
assert.ok(['--prepare', '--check', '--play'].includes(mode) && path.isAbsolute(directory || ''), 'Usage: node listen.cjs --prepare|--check|--play /private/test-directory')
const root = path.resolve(__dirname, '../..')
const config = JSON.parse(fs.readFileSync(path.join(directory, 'listen.json'), 'utf8'))
const qualityTest = config.scenario === 'quality'
const automaticTest = config.scenario === 'automatic'
const singleTrack = qualityTest || automaticTest
const scenario = automaticTest ? 'automatic' : qualityTest ? 'quality' : 'gapless'
const lifetimeSeconds = automaticTest ? 160 : 90
const ffmpeg = require('ffmpeg-static')
const ffprobe = require('ffprobe-static').path
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, message, ms = 8000) {
  const end = Date.now() + ms
  while (!check()) { assert.ok(Date.now() < end, message); await delay(20) }
}
async function prepare() {
  assert.ok(config.sources.length >= (singleTrack ? 1 : 2))
  for (let index = 0; index < (singleTrack ? 1 : 2); index++) {
    const source = config.sources[index]
    const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate,channels,duration_ts,time_base', '-of', 'json', source], { timeout: 10000 })).streams[0]
    assert.equal(Number(info.sample_rate), 48000); assert.equal(info.channels, 2)
    const [num, den] = info.time_base.split('/').map(Number)
    const total = Math.round(Number(info.duration_ts) * num / den * 48000)
    assert.ok(total >= (automaticTest ? 8640000 : qualityTest ? 5376000 : 768000), 'Source is shorter than the requested excerpt.')
    const filter = automaticTest ? 'atrim=start_sample=3840000:end_sample=8640000,asetpts=PTS-STARTPTS'
      : qualityTest ? 'atrim=start_sample=3840000:end_sample=5376000,asetpts=PTS-STARTPTS'
      : index ? 'atrim=end_sample=768000,asetpts=PTS-STARTPTS'
      : `atrim=start_sample=${total - 768000},asetpts=PTS-STARTPTS`
    execFileSync(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-i', source, '-map', '0:a:0', '-af', filter,
      '-c:a', 'flac', '-map_metadata', '-1', path.join(directory, `${index ? 'second' : 'first'}.flac`)], { timeout: 15000 })
  }
  await build({ entryPoints: [path.join(__dirname, 'listenRenderer.ts')], bundle: true, format: 'esm', platform: 'browser',
    outfile: path.join(directory, 'renderer.js'), external: ['*?worker&inline'], logLevel: 'warning' })
  await build({ entryPoints: [path.join(__dirname, 'listenMain.ts')], bundle: true, format: 'cjs', platform: 'node',
    outfile: path.join(directory, 'main.cjs'), external: ['electron'], logLevel: 'warning',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(__dirname, 'mainHarness.ts')).href) } })
  // Node preflight uses the same actual main-session functions without Electron.
  await build({ entryPoints: [path.join(__dirname, 'mainHarness.ts')], bundle: true, format: 'cjs', platform: 'node',
    outfile: path.join(directory, 'harness.cjs'), logLevel: 'warning',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(__dirname, 'mainHarness.ts')).href) } })
  fs.copyFileSync(path.join(root, 'src/renderer/public/oscilloscope-worklet.js'), path.join(directory, 'oscilloscope-worklet.js'))
  fs.writeFileSync(path.join(directory, 'preload.cjs'), `
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('stratumListen', {scenario:${JSON.stringify(scenario)}});
const listen=(name,cb)=>{const fn=(_e,data)=>cb(data);ipcRenderer.on(name,fn);return()=>ipcRenderer.removeListener(name,fn)};
contextBridge.exposeInMainWorld('electronAPI', {
 startProgressiveStream:(...args)=>ipcRenderer.invoke('test:start',...args),
 cancelProgressiveStream:id=>ipcRenderer.invoke('test:cancel',id),
 cancelPendingProgressiveStream:slot=>ipcRenderer.invoke('test:pending',slot),
 updateProgressiveStreamPosition:(id,frame)=>ipcRenderer.send('test:position',id,frame),
 activateProgressiveStream:id=>ipcRenderer.send('test:activate',id),
 onProgressiveStreamChunk:cb=>listen('audio:progressiveStreamChunk',cb),
 onProgressiveStreamEvent:cb=>listen('audio:progressiveStreamEvent',cb)
});`)
  fs.writeFileSync(path.join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'">
<title>Astra · Stratum listening check</title><style>body{background:#17191c;color:#eee;font:18px system-ui;padding:28px}button{font:inherit;padding:10px 28px}small{color:#aaa}</style></head><body>
<h2>Stratum · Bluetooth listening check</h2><p id="message">Preparing…</p><p><small>${automaticTest ? 100 : 32} seconds · reduced volume · temporary profile</small></p>
<button id="stop">Stop</button><script type="module" src="./renderer.js"></script></body></html>`)
  execFileSync('/usr/bin/clang++', ['-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror', path.join(__dirname, 'outputRoute.cpp'),
    '-framework', 'CoreAudio', '-framework', 'CoreFoundation', '-o', path.join(directory, 'output-route')], { timeout: 20000 })
  console.log('PREPARED: exact music excerpts, one bounded app entry, read-only output guard. No playback or Electron launch.')
}

async function run() {
  const children = []
  const start = (file, args, options) => {
    const child = spawn(file, args, options)
    const done = new Promise(resolve => { child.once('error', () => resolve(1)); child.once('close', code => resolve(code)) })
    children.push({ child, done }); return { child, done }
  }
  const terminate = () => { for (const { child } of children) if (child.exitCode === null) child.kill('SIGTERM') }
  const force = () => { for (const { child } of children) if (child.exitCode === null) child.kill('SIGKILL') }
  const deadline = setTimeout(force, lifetimeSeconds * 1000)
  process.once('SIGINT', terminate); process.once('SIGTERM', terminate)
  let upstream, active, link
  try {
    let guard
    if (mode === '--play') {
      guard = start(path.join(directory, 'output-route'), [config.outputUid, 'watch', String(lifetimeSeconds)], { stdio: ['ignore', 'pipe', 'inherit'] })
      let verified = false
      guard.child.stdout.on('data', chunk => { if (chunk.toString().includes('ROUTE_VERIFIED')) verified = true })
      await until(() => verified || guard.child.exitCode !== null, 'Audio route check timed out.')
      assert.ok(verified && guard.child.exitCode === null, 'The expected Bluetooth output is not selected. Nothing played.')
      void guard.done.then(() => { if (active && active.child.exitCode === null) active.child.kill('SIGTERM') })
    }
    const token = randomBytes(16).toString('hex')
    const files = { first: path.join(directory, 'first.flac'), second: path.join(directory, 'second.flac') }
    upstream = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 4096) { req.destroy(); return } }
      const params = new URLSearchParams(body)
      const reply = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ 'subsonic-response': value })) }
      if (params.get('u') !== 'listener' || params.get('t') !== token) return reply({ status: 'failed', error: { code: 40 } })
      if (req.url.endsWith('ping.view')) return reply({ status: 'ok' })
      const file = files[params.get('id')]
      if (!file) return reply({ status: 'failed', error: { code: 70 } })
      const size = fs.statSync(file).size
      if (req.url.endsWith('getSong.view')) return reply({ status: 'ok', song: { id: params.get('id'), size } })
      if (!req.url.endsWith('stream.view')) { res.writeHead(404); res.end(); return }
      const range = req.headers.range === 'bytes=0-0'
      res.writeHead(range ? 206 : 200, { 'content-type': 'audio/flac', 'content-length': range ? 1 : size,
        ...(range ? { 'content-range': `bytes 0-0/${size}` } : {}) })
      const stream = fs.createReadStream(file, range ? { start: 0, end: 0 } : undefined)
      res.once('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res)
    })
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
    const sidecarFile = path.join(directory, 'sidecar.json')
    fs.writeFileSync(sidecarFile, JSON.stringify({ upstream: `http://127.0.0.1:${upstream.address().port}`, run_seconds: lifetimeSeconds }), { mode: 0o600 })
    const service = start(config.sidecar, ['--config', sidecarFile], { env: { ...process.env, TMPDIR: directory }, stdio: ['ignore', 'pipe', 'inherit'] })
    let greeting = ''
    service.child.stdout.on('data', chunk => { greeting += chunk.toString() })
    await until(() => greeting.includes('\n'), 'Sidecar did not start.')
    const endpoint = JSON.parse(greeting.split('\n')[0]).listen
    const result = await fetch(`${endpoint}/access/v1/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'listener', token, salt: 'disposable-listen' }), signal: AbortSignal.timeout(3000) })
    assert.equal(result.status, 201)
    const connection = { endpoint, session: (await result.json()).session, sourceId: 7, tracks: ['first', 'second'] }
    if (automaticTest) {
      link = await require('./throttledLink.cjs').throttledLink(endpoint)
      connection.endpoint = link.endpoint
    }
    if (mode === '--check' && automaticTest) {
      await require('./automaticPreflight.cjs').automaticPreflight(directory, connection, ffmpeg)
    } else if (mode === '--check') {
      const { mainHarness } = require(path.join(directory, 'harness.cjs'))
      const h = mainHarness(connection, ffmpeg, qualityTest ? { segmentQuality: seconds => seconds >= 12 && seconds < 24 ? 'opus-64' : 'lossless' } : {})
      try {
        for (const [id, quality] of (qualityTest ? [['first', 'original']] : [['first', 'original'], ['second', 64]])) {
          const info = await h.start(id, 44100, quality)
          const tick = setInterval(() => h.ready(info.sessionId), 5)
          try { await until(() => h.events.some(e => e.sessionId === info.sessionId && ['complete', 'failed'].includes(e.type)), 'Clip decoding failed to finish.', 15000) }
          finally { clearInterval(tick) }
          assert.ok(!h.events.some(e => e.sessionId === info.sessionId && e.type === 'failed'))
          const pcm = Buffer.concat([Buffer.from(info.initialChunk.pcmData), ...h.chunks.filter(c => c.sessionId === info.sessionId).map(c => Buffer.from(c.pcmData))])
          assert.equal(pcm.length, (qualityTest ? 32 : 16) * 44100 * 8)
          if (id === 'first') {
            const expected = execFileSync(ffmpeg, ['-v', 'error', '-i', files.first, '-af', 'aresample=44100:resampler=swr:exact_rational=1:async=0:dither_method=none', '-f', 'f32le', 'pipe:1'], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 })
            if (qualityTest) {
              assert.deepEqual(pcm.subarray(0, 11 * 44100 * 8), expected.subarray(0, 11 * 44100 * 8))
              assert.deepEqual(pcm.subarray(25 * 44100 * 8), expected.subarray(25 * 44100 * 8))
              assert.deepEqual(h.qualityEvents.map(e => e.quality), ['lossless', 'lossless', 'lossless', 'opus-64', 'opus-64', 'opus-64', 'lossless', 'lossless'])
              assert.equal(h.events.filter(e => e.type === 'started').length, 1)
            } else assert.deepEqual(pcm, expected)
          }
        }
        console.log('SILENT_PREFLIGHT_PASSED: music through authenticated Stratum and actual Astra sessions at 44.1 kHz.')
      } finally { await h.close() }
    } else {
      fs.writeFileSync(path.join(directory, 'active.json'), JSON.stringify({ connection, ffmpeg, scenario }), { mode: 0o600 })
      assert.ok(guard.child.exitCode === null, 'Bluetooth output changed before launch.')
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      active = start(require('electron'), [path.join(directory, 'main.cjs'), directory], { env, stdio: 'inherit' })
      assert.equal(await active.done, 0, 'Listening app did not finish successfully.')
      console.log('APP_EXITED')
    }
  } finally {
    terminate()
    const killTimer = setTimeout(force, 3000)
    await Promise.all(children.map(entry => entry.done))
    clearTimeout(killTimer); clearTimeout(deadline)
    if (link) {
      await link.close()
      fs.writeFileSync(path.join(directory, mode === '--check' ? 'silent-link.json' : 'listening-link.json'), JSON.stringify(link.segments, null, 2))
    }
    if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) }
    await fsp.rm(path.join(directory, 'active.json'), { force: true })
    console.log('CLEANUP_COMPLETE')
  }
}
(mode === '--prepare' ? prepare() : run()).catch(error => { console.error(error.message); process.exitCode = 1 })
