// Node-only supervisor. One explicit, muted Electron child; never relaunches.
const fs = require('node:fs')
const path = require('node:path')
const { createServer } = require('node:http')
const { randomBytes, createHash } = require('node:crypto')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const assert = require('node:assert/strict')
if (process.versions.electron) throw new Error('Use Node for the full-app supervisor.')
const [mode, directory] = process.argv.slice(2)
assert.ok(['--prepare', '--check'].includes(mode) && path.isAbsolute(directory || ''), 'Usage: node fullApp.cjs --prepare|--check /private/test-directory')
const root = path.resolve(__dirname, '../..')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(test, message) {
  const deadline = Date.now() + 10000
  while (!test()) { if (Date.now() > deadline) throw new Error(message); await pause(25) }
}
async function prepare() {
  fs.mkdirSync(path.join(directory, 'music'), { recursive: true })
  for (const [index, id] of ['first', 'second'].entries()) {
    execFileSync(require('ffmpeg-static'), ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi',
      '-i', `anoisesrc=color=pink:sample_rate=48000:duration=8:seed=${1234 + index}:amplitude=0.1`,
      '-ac', '2', '-c:a', 'flac', '-sample_fmt', 's16', '-metadata', `title=${id}`,
      '-metadata', 'artist=Stratum Fixture', '-metadata', 'album=Local Fixture',
      '-metadata', `track=${index + 1}/2`, path.join(directory, 'music', `${id}.flac`)], { timeout: 10000 })
  }
  fs.mkdirSync(path.join(directory, 'resources'), { recursive: true })
  for (const [name, target] of [['native', 'native/build/Release'], ['hrtf', 'resources/hrtf'], ['tray', 'resources/tray']]) {
    const link = path.join(directory, 'resources', name)
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(root, target), link, 'dir')
  }
  if (!fs.existsSync(path.join(directory, 'node_modules'))) fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir')
  if (!fs.existsSync(path.join(directory, 'native'))) fs.symlinkSync(path.join(root, 'native'), path.join(directory, 'native'), 'dir')
  execFileSync(process.execPath, [path.join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build', '--config',
    path.join(__dirname, 'fullApp.config.ts')], { cwd: root, env: { ...process.env, ASTRA_STRATUM_APP_DIRECTORY: directory }, timeout: 120000, stdio: 'inherit' })
  console.log('FULL_APP_PREPARED: no Electron or playback launched.')
}
async function check() {
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'))
  const password = randomBytes(24).toString('hex')
  const token = createHash('md5').update(password + 'fixture').digest('hex')
  const children = []
  let upstream
  const requests = []
  let terminating = false
  const start = (file, args, options) => {
    const child = spawn(file, args, options)
    const done = new Promise(resolve => { child.once('error', () => resolve(1)); child.once('close', code => resolve(code)) })
    children.push({ child, done }); return { child, done }
  }
  const terminate = () => { terminating = true; for (const { child } of children) if (child.exitCode === null) child.kill('SIGTERM') }
  const force = () => { for (const { child } of children) if (child.exitCode === null) child.kill('SIGKILL') }
  const deadline = setTimeout(force, 180000)
  process.once('SIGINT', terminate); process.once('SIGTERM', terminate)
  try {
    const songs = ['first', 'second'].map((id, i) => ({ id, title: id, artist: 'Stratum Fixture', album: 'Remote Fixture',
      albumId: 'album', artistId: 'artist', duration: 8, track: i + 1, discNumber: 1, suffix: 'flac',
      contentType: 'audio/flac', samplingRate: 48000, bitDepth: 16, channelCount: 2,
      size: fs.statSync(path.join(directory, 'music', `${id}.flac`)).size }))
    upstream = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1')
        let body = ''
        for await (const chunk of req) { body += chunk; if (body.length > 8192) throw new Error('Request too large') }
        const params = new URLSearchParams(body || url.search)
        const reply = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ 'subsonic-response': {
          status: 'ok', version: '1.16.1', type: 'navidrome', ...data
        } })) }
        if (params.get('u') !== 'fixture' || params.get('t') !== createHash('md5').update(password + params.get('s')).digest('hex')) {
          reply({ status: 'failed', error: { code: 40, message: 'Fixture credentials refused' } }); return
        }
        const method = url.pathname.split('/').pop().replace(/\.view$/, '')
        // Deliberately record no credentials or query strings.
        requests.push({ method, id: params.get('id') ?? params.get('mediaId'), state: params.get('state') })
        if (method === 'ping') return reply({})
        if (method === 'getArtists') return reply({ artists: { index: [{ name: 'S', artist: [{ id: 'artist', name: 'Stratum Fixture' }] }] } })
        if (method === 'getArtist') return reply({ artist: { id: 'artist', album: [{ id: 'album' }] } })
        if (method === 'getAlbum') return reply({ album: { id: 'album', song: songs } })
        if (method === 'getOpenSubsonicExtensions') return reply({ openSubsonicExtensions: [{ name: 'playbackReport', versions: [1] }] })
        if (['scrobble', 'reportPlayback'].includes(method)) return reply({})
        if (method === 'getPlaylists') return reply({ playlists: { playlist: [] } })
        if (method === 'getStarred') return reply({ starred: { song: [] } })
        const song = songs.find(song => song.id === params.get('id'))
        if (method === 'getSong' && song) return reply({ song })
        if (method !== 'stream' || !song) { res.writeHead(404); res.end(); return }
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
        const begin = range ? Number(range[1]) : 0
        const end = range && range[2] ? Math.min(Number(range[2]), song.size - 1) : song.size - 1
        if (begin > end) { res.writeHead(416); res.end(); return }
        res.writeHead(range ? 206 : 200, { 'content-type': 'audio/flac', 'content-length': end - begin + 1,
          'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${begin}-${end}/${song.size}` } : {}) })
        const stream = fs.createReadStream(path.join(directory, 'music', `${song.id}.flac`), { start: begin, end })
        res.once('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res)
      } catch { res.destroy() }
    })
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`
    const serviceConfig = path.join(directory, 'sidecar.json')
    fs.writeFileSync(serviceConfig, JSON.stringify({ upstream: baseUrl, run_seconds: 180 }), { mode: 0o600 })
    const service = start(config.sidecar, ['--config', serviceConfig], { env: { ...process.env, TMPDIR: directory }, stdio: ['ignore', 'pipe', 'inherit'] })
    let greeting = ''
    service.child.stdout.on('data', chunk => { greeting += chunk.toString() })
    await until(() => greeting.includes('\n') || service.child.exitCode !== null, 'Sidecar startup timed out')
    const endpoint = JSON.parse(greeting.split('\n')[0]).listen
    const response = await fetch(`${endpoint}/access/v1/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'fixture', token, salt: 'fixture' }), signal: AbortSignal.timeout(3000) })
    assert.equal(response.status, 201)
    fs.writeFileSync(path.join(directory, 'proof.json'), JSON.stringify({ experiment: 'astra-stratum-standard-proof-1', endpoint,
      session: (await response.json()).session, sourceId: 1, tracks: ['first', 'second'] }), { mode: 0o600 })
    fs.writeFileSync(path.join(directory, 'active.json'), JSON.stringify({ baseUrl, password }), { mode: 0o600 })
    assert.ok(!terminating, 'Run was cancelled')
    const env = { ...process.env, NODE_ENV: 'development', ASTRA_STRATUM_PROOF_CONFIG: path.join(directory, 'proof.json') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    fs.rmSync(path.join(directory, 'full-app-report.json'), { force: true })
    const app = start(require('electron'), [path.join(__dirname, 'fullAppMain.cjs'), directory], { env, stdio: 'inherit' })
    assert.equal(await app.done, 0, 'Full-app check failed; inspect full-app-report.json')
    const report = JSON.parse(fs.readFileSync(path.join(directory, 'full-app-report.json'), 'utf8'))
    assert.equal(report.success, true, 'Full-app assertions failed; inspect full-app-report.json')
    assert.ok(requests.some(request => request.method === 'reportPlayback' && request.state === 'playing'), 'Real provider reporting must reach the fixture server')
    console.log('FULL_APP_PASSED')
  } finally {
    terminate()
    const killTimer = setTimeout(force, 3000)
    await Promise.all(children.map(entry => entry.done))
    clearTimeout(killTimer); clearTimeout(deadline)
    if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) }
    fs.writeFileSync(path.join(directory, 'upstream-report.json'), JSON.stringify(requests, null, 2))
    for (const name of ['active.json', 'proof.json']) fs.rmSync(path.join(directory, name), { force: true })
    console.log('CLEANUP_COMPLETE')
  }
}
(mode === '--prepare' ? prepare() : check()).catch(error => { console.error(error.message); process.exitCode = 1 })
