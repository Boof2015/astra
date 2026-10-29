// Shaped-link baseline: a disposable real Navidrome and installed HTTPS Sidecar,
// with Astra's actual installed-route session code behind one shared shaped link
// (shapedLink.cjs). Conventional Subsonic streaming crosses the same link as a
// baseline. PCM is consumed through the real worklet at wall-clock speed; no
// audio device, Electron window, personal library or live server is used.
// Sources are read only; each scenario plays its own tagged copies so Sidecar's
// retained cache starts cold. Credentials are generated and never logged.
//
//   node --experimental-strip-types --loader ./scripts/node/electron-test-loader.mjs \
//     scripts/stratum/shapedBaseline.ts /private/test-directory
//
// The directory holds config.json:
//   { "navidrome": "/path/navidrome", "sidecar": "/path/target/release/sidecar",
//     "sources": ["/path/current.flac", "/path/next.flac"], "profile": "3g",
//     "scenarios": ["stratum-automatic", ...], "playSeconds": null, "nextSeconds": 20 }
// and receives shaped-report.json.
import assert from 'node:assert/strict'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes, createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { promisify } from 'node:util'
import { mainHarness } from './mainHarness.ts'
import { StratumConnections } from '../../src/main/services/stratumConnections.ts'
import { StratumAudioCache } from '../../src/main/services/stratumAudioCache.ts'
import { RemoteAudioCache } from '../../src/main/services/remoteAudioCache.ts'
import { decodeStratumProofSegment } from '../../src/main/services/stratumProofPlayback.ts'
import { analyzeRemoteAudioPcm } from '../../src/main/services/remoteAudioAnalysis.ts'
import { AutomaticStreamingQuality } from '../../src/main/services/automaticStreamingQuality.ts'
import { acquireQualityAudio } from '../../src/main/services/streamingQualityAcquisition.ts'
import { createSubsonicAudioSource } from '../../src/main/services/subsonicAudioSource.ts'
import { buildSubsonicTrackPath, getSubsonicRadios, parseSubsonicTrackPath } from '../../src/main/services/subsonic.ts'
import { PlaybackNetworkPriority } from '../../src/main/services/playbackNetworkPriority.ts'
import type { StratumProofAuthentication } from '../../src/main/services/stratumProofClient.ts'
import type { StratumConnections as Connections } from '../../src/main/services/stratumConnections.ts'
import type { StreamingQualityRequest } from '../../src/types/streamingQuality.ts'

const require = createRequire(import.meta.url)
const { shapedLink } = require('./shapedLink.cjs')
const ffmpeg = require('ffmpeg-static') as string
const execute = promisify(execFile)
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const STRATUM_SOURCE = 7, CONVENTIONAL_SOURCE = 8, RATE = 48000

// `art`: a page of cover downloads is already running when the track is clicked,
// either through the production scheduler (yielding to playback) or directly.
interface Scenario { name: string; route: 'stratum' | 'conventional'; quality: StreamingQualityRequest; next: boolean; art?: 'priority' | 'direct' }
const SCENARIOS: Record<string, Scenario> = {
  'stratum-automatic': { name: 'stratum-automatic', route: 'stratum', quality: 'automatic', next: false },
  'stratum-automatic-next': { name: 'stratum-automatic-next', route: 'stratum', quality: 'automatic', next: true },
  'stratum-prioritize-next': { name: 'stratum-prioritize-next', route: 'stratum', quality: 'automatic-original', next: true },
  'stratum-128-next': { name: 'stratum-128-next', route: 'stratum', quality: 128, next: true },
  'stratum-64-next': { name: 'stratum-64-next', route: 'stratum', quality: 64, next: true },
  'conventional-128-next': { name: 'conventional-128-next', route: 'conventional', quality: 128, next: true },
  'conventional-64-next': { name: 'conventional-64-next', route: 'conventional', quality: 64, next: true },
  'stratum-automatic-art': { name: 'stratum-automatic-art', route: 'stratum', quality: 'automatic', next: false, art: 'priority' },
  'stratum-automatic-art-direct': { name: 'stratum-automatic-art-direct', route: 'stratum', quality: 'automatic', next: false, art: 'direct' }
}

const directory = process.argv[2]
assert.ok(directory, 'Usage: shapedBaseline.ts /private/test-directory')
const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8')) as {
  navidrome: string; sidecar: string; sources: [string, string]; profile?: string
  scenarios?: string[]; playSeconds?: number | null; nextSeconds?: number; schedule?: Array<{ atMs: number; profile: string }>
  artCount?: number; artBytes?: number; artLeadMs?: number
}
const scenarios = (config.scenarios ?? Object.keys(SCENARIOS)).map(name => {
  assert.ok(SCENARIOS[name], `Unknown scenario ${name}`)
  return SCENARIOS[name]
})
const work = join(directory, `run-${Date.now()}`)
const children: ChildProcess[] = []
const watchdog = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); process.exit(124) },
  (10 + scenarios.length * 7) * 60_000)
watchdog.unref()

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise(resolve => server.close(resolve))
  return port
}
function child(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const value = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
  value.stderr!.resume()
  children.push(value)
  return value
}
async function cli(...args: string[]): Promise<void> {
  const password = args.at(-1)!.startsWith('stdin:') ? args.pop()!.slice(6) : undefined
  await new Promise<void>((resolve, reject) => {
    const value = spawn(config.sidecar, [...args, '--data-dir', join(work, 'sidecar')], { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    value.stderr.on('data', chunk => { stderr += chunk })
    value.on('close', code => code === 0 ? resolve() : reject(new Error(`sidecar ${args[0]} failed: ${stderr.slice(0, 400)}`)))
    value.stdin.end(password ?? '')
  })
}
function subsonic(base: string, user: string, password: string) {
  return async (endpoint: string, params: Record<string, string> = {}) => {
    const salt = randomBytes(8).toString('hex')
    const query = new URLSearchParams({ u: user, t: createHash('md5').update(password + salt).digest('hex'), s: salt,
      v: '1.16.1', c: 'astra-shaped', f: 'json', ...params })
    const response = await fetch(`${base}/rest/${endpoint}?${query}`)
    const value = await response.json() as { 'subsonic-response': Record<string, any> }
    assert.equal(value['subsonic-response'].status, 'ok', `${endpoint} failed`)
    return value['subsonic-response']
  }
}
async function until<T>(read: () => Promise<T | undefined> | T | undefined, message: string, ms = 30_000): Promise<T> {
  const deadline = performance.now() + ms
  for (;;) {
    try { const value = await read(); if (value !== undefined && value !== false) return value } catch { /* retry */ }
    assert.ok(performance.now() < deadline, message)
    await delay(100)
  }
}
const capabilities = (port: number) => new Promise<Record<string, unknown>>((resolve, reject) => {
  const req = httpsRequest({ host: '127.0.0.1', port, path: '/stratum/access/v1/capabilities', rejectUnauthorized: false,
    agent: false }, response => {
    const chunks: Buffer[] = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())) } catch (error) { reject(error) } })
  })
  req.on('error', reject)
  req.end()
})
const loadWorklet = () => {
  let Processor: any
  let outputFrame = 0
  runInNewContext(readFileSync(new URL('../../src/renderer/public/oscilloscope-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { port = { onmessage: null as any, postMessage: (_value: unknown) => {} } },
    registerProcessor: (name: string, value: any) => { if (name === 'remote-stream-player') Processor = value },
    Float32Array, sampleRate: RATE, get currentFrame() { return outputFrame }
  })
  const worklet = new Processor({ outputChannelCount: [2], processorOptions: { discardConsumedChunks: true } })
  return { worklet, frames: () => outputFrame, render: (frames: number) => {
    worklet.process([], [[new Float32Array(frames), new Float32Array(frames)]])
    outputFrame += frames
  } }
}

/** Records every installed-route request: what it was, connection setup, header wait and body. */
function instrument(connection: StratumProofAuthentication, log: any[], began: () => number): StratumProofAuthentication {
  const request = connection.request!
  return {
    get endpoint() { return connection.endpoint }, get signal() { return connection.signal },
    getBearer: signal => connection.getBearer(signal), reject: () => connection.reject(),
    request: async (path, method, signal, body, bearer, limit, observe) => {
      const kind = path.endsWith('/segment') ? 'segment' : path.startsWith('/audio/v1/playbacks/') ? 'open'
        : method === 'DELETE' ? 'close' : path.replace(/^\/(access|audio)\/v1\//, '')
      const entry: any = { kind, method, atMs: began(), ...(kind === 'segment' ? body as object : {}) }
      log.push(entry)
      const started = performance.now()
      try {
        const result = await request(path, method, signal, body, bearer, limit, event => {
          if (event.phase === 'start') {
            entry.headersMs = performance.now() - started
            entry.connectionMs = event.connectionMs; entry.responseWaitMs = event.responseWaitMs
          }
          observe?.(event)
        })
        entry.totalMs = performance.now() - started
        entry.bytes = result.bytes.length
        return result
      } catch (error) {
        entry.totalMs = performance.now() - started
        entry.error = signal.aborted ? 'aborted' : error instanceof Error ? error.message : 'failed'
        throw error
      }
    }
  }
}

async function main() {
  await mkdir(work, { recursive: true })
  const report: any = { profile: config.profile ?? '3g', schedule: config.schedule ?? null, startedAt: new Date().toISOString(),
    sources: [], scenarios: [] }
  // Tagged read-only copies: same audio, distinct bytes, hence a cold Sidecar cache per scenario.
  const music = join(work, 'music')
  await mkdir(music)
  const durations: number[] = []
  for (const source of config.sources) {
    const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,bit_rate:stream=sample_rate,bits_per_raw_sample', '-select_streams', 'a:0',
        '-of', 'json', source])
    const probe = JSON.parse(stdout)
    durations.push(Number(probe.format.duration))
    report.sources.push({ duration: Number(probe.format.duration), bitrate: Number(probe.format.bit_rate),
      sampleRate: Number(probe.streams[0].sample_rate), bits: Number(probe.streams[0].bits_per_raw_sample) })
  }
  for (const [index, scenario] of scenarios.entries()) {
    for (const [slot, source] of config.sources.entries()) {
      await execute(ffmpeg, ['-v', 'error', '-nostdin', '-i', source, '-map', '0', '-c', 'copy',
        '-metadata', `title=${scenario.name}-${slot ? 'next' : 'current'}`, '-metadata', `album=Shaped ${index}`,
        '-metadata', `comment=${randomBytes(8).toString('hex')}`, join(music, `${index}-${slot}.flac`)])
    }
  }

  const [nav, side] = [await freePort(), await freePort()]
  // Cover-sized responses standing in for a page of album art from the same server.
  const artBody = randomBytes(config.artBytes ?? 250_000)
  const artServer = createHttpServer((_req, res) => { res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(artBody) })
  await new Promise<void>(resolve => artServer.listen(0, '127.0.0.1', resolve))
  const link = await shapedLink({ navidrome: nav, sidecar: side, art: (artServer.address() as { port: number }).port },
    { profile: config.profile ?? '3g' })
  link.setProfile('lan') // Setup itself is not measured; scenarios select the profile.
  const direct = `http://127.0.0.1:${nav}`, shaped = `http://127.0.0.1:${link.ports.navidrome}`
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ND_')))
  Object.assign(env, { ND_ADDRESS: '127.0.0.1', ND_PORT: String(nav), ND_MUSICFOLDER: music,
    ND_DATAFOLDER: join(work, 'nav-data'), ND_CACHEFOLDER: join(work, 'nav-cache'), ND_LOGLEVEL: 'error',
    ND_ENABLEEXTERNALSERVICES: 'false', ND_ENABLEINSIGHTSCOLLECTOR: 'false', ND_ENABLEGRAVATAR: 'false',
    ND_ENABLEARTWORKPRECACHE: 'false', ND_SCANNER_SCHEDULE: '0', ND_FFMPEGPATH: ffmpeg })
  child(config.navidrome, [], env)
  await until(async () => (await fetch(`${direct}/ping`)).ok || undefined, 'Navidrome did not start.')
  const adminPassword = randomBytes(18).toString('base64url'), password = randomBytes(18).toString('base64url')
  const ownerPassword = randomBytes(18).toString('base64url')
  const admin = await (await fetch(`${direct}/auth/createAdmin`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'shaped-admin', password: adminPassword }) })).json() as { token: string }
  assert.ok((await fetch(`${direct}/api/user`, { method: 'POST', headers: { 'content-type': 'application/json',
    'x-nd-authorization': `Bearer ${admin.token}` },
    body: JSON.stringify({ userName: 'listener', name: 'Listener', password, isAdmin: false }) })).ok, 'Listener creation failed.')
  const asAdmin = subsonic(direct, 'shaped-admin', adminPassword), asListener = subsonic(direct, 'listener', password)
  await asAdmin('startScan')
  const songs = await until(async () => {
    const found = (await asListener('search3', { query: '', songCount: '100' })).searchResult3?.song ?? []
    return found.length === scenarios.length * 2 ? found as Array<{ id: string; title: string }> : undefined
  }, 'Navidrome scan did not finish.', 60_000)
  const songId = (name: string, slot: 'current' | 'next') => songs.find(song => song.title === `${name}-${slot}`)!.id

  await cli('init', '--listen', `127.0.0.1:${side}`, '--admin-origin', `https://127.0.0.1:${side}`)
  await cli('set-password', '--password-stdin', `stdin:${ownerPassword}`)
  await writeFile(join(work, 'settings.json'), JSON.stringify({ navidrome_url: direct,
    listeners: [{ url: `https://127.0.0.1:${link.ports.sidecar}`, trust: 'sidecar_key' }] }))
  await cli('configure', '--settings', join(work, 'settings.json'))
  await cli('publish-discovery', '--username', 'shaped-admin', '--password-stdin', `stdin:${adminPassword}`)
  child(config.sidecar, ['serve', '--data-dir', join(work, 'sidecar')])
  await until(async () => (await capabilities(side)).ready === true || undefined, 'Sidecar did not become ready.')

  const signIn = { baseUrl: shaped, username: 'listener', password }
  let saved = ''
  const manager = new StratumConnections({ source: id => id === STRATUM_SOURCE ? { binding: 'a'.repeat(64), enabled: true } : null,
    credentials: async () => signIn, radios: (_id, signal) => getSubsonicRadios(signIn, signal),
    read: () => saved, write: async value => { saved = value }, changed() {} })
  try {
    link.setProfile(config.profile ?? '3g')
    const setupStarted = performance.now()
    assert.equal((await manager.discover(STRATUM_SOURCE)).state, 'available')
    const discovered = performance.now()
    await manager.setEnabled(STRATUM_SOURCE, true)
    await manager.connection(STRATUM_SOURCE, AbortSignal.timeout(120_000))
    report.setup = { discoverMs: discovered - setupStarted, enableAndSessionMs: performance.now() - discovered }
    const approved = manager.cachedConnection(STRATUM_SOURCE)!
    assert.ok(approved, 'Stratum connection was not approved.')

    for (const [index, scenario] of scenarios.entries()) {
      console.log(`scenario ${scenario.name}`)
      const result = await runScenario(index, scenario, approved, signIn, durations, songId)
      report.scenarios.push(result)
      console.log(JSON.stringify(summary(result)))
      await writeFile(join(directory, 'shaped-report.json'), JSON.stringify(report, null, 2))
    }
  } finally {
    manager.close()
    await link.close()
    artServer.closeAllConnections()
    await new Promise(resolve => artServer.close(resolve))
  }
  report.finishedAt = new Date().toISOString()
  report.summary = report.scenarios.map(summary)
  await writeFile(join(directory, 'shaped-report.json'), JSON.stringify(report, null, 2))
  console.table(report.summary)

  async function runScenario(index: number, scenario: Scenario, approved: { connection: StratumProofAuthentication; scope: string },
    signIn: { baseUrl: string; username: string; password: string }, durations: number[],
    songId: (name: string, slot: 'current' | 'next') => string) {
    const began = performance.now()
    const at = () => (performance.now() - began) / 1000
    if (config.schedule) link.schedule(config.schedule)
    else link.setProfile(config.profile ?? '3g')
    link.resetStats()
    const requests: any[] = []
    const fallbacks: string[] = []
    const disk = new RemoteAudioCache(join(work, `cache-${index}`), 1024 ** 3, {
      analyze: async () => { throw new Error('Segment sent to file scanner.') }, ready: () => {} })
    const retained = new StratumAudioCache(disk, {
      decode: (segment, signal) => decodeStratumProofSegment(ffmpeg, segment, signal),
      scan: (source, pcm, signal) => analyzeRemoteAudioPcm(ffmpeg, source, pcm, signal)
    })
    const connection = { scope: `${approved.scope}:${index}`, connection: instrument(approved.connection, requests, at) }
    const installed = { cachedConnection: (id: number) => id === STRATUM_SOURCE ? connection : null,
      playbackStarted() {}, playbackFailed(_id: number, error: Error) { fallbacks.push(error?.message ?? 'failed') } } as unknown as Connections
    const sourceId = scenario.route === 'stratum' ? STRATUM_SOURCE : CONVENTIONAL_SOURCE
    const paths = (['current', 'next'] as const).map(slot => buildSubsonicTrackPath(sourceId, songId(scenario.name, slot)))
    const conventional: any[] = []
    const policy = new AutomaticStreamingQuality()
    const priority = new PlaybackNetworkPriority()
    const { worklet, render, frames: renderedFrames } = loadWorklet()
    const send = (data: unknown) => worklet.port.onmessage({ data })
    const sessions = new Map<number, { slot: 'current' | 'next'; markers: any[]; played: any[]; frames: number }>()
    const append = (value: any) => {
      const state = sessions.get(value.sessionId)
      if (!state) return
      state.markers.push(...(value.qualityChanges ?? []))
      state.frames += value.frameCount
      send({ type: 'append-chunk', sessionId: value.sessionId, frameCount: value.frameCount,
        interleavedData: new Float32Array(value.pcmData), channelCount: 2 })
    }
    const h = mainHarness({ sourceId: STRATUM_SOURCE, endpoint: 'http://127.0.0.1:1', session: '0'.repeat(64), tracks: ['unused'] } as any,
      ffmpeg, { installed, cache: retained, policy, priority, recordPcm: false,
        duration: path => durations[paths.indexOf(path)],
        acquire: async (path, signal, quality) => {
          const trackId = parseSubsonicTrackPath(path)!.sourceTrackId
          const kbps = report.sources[paths.indexOf(path)].bitrate / 1000
          const entry: any = { path: paths.indexOf(path) ? 'next' : 'current', atMs: at() }
          conventional.push(entry)
          const make = (target: any, compatibility?: any) => {
            const source = createSubsonicAudioSource({ sourceId: CONVENTIONAL_SOURCE, connection: signIn, trackId,
              revision: 'shaped', quality: target, compatibility })
            const open = source.open
            source.open = async signal => {
              const started = performance.now()
              const response = await open(signal)
              entry.headersMs = performance.now() - started
              return response
            }
            return source
          }
          const lease = await acquireQualityAudio({ cache: disk, policy, key: 'subsonic:shaped', make,
            track: { codec: 'flac', format: 'flac', bitrate: kbps }, originalKbps: kbps,
            selected: quality ?? scenario.quality, signal })
          void lease.finished().then(() => { entry.completeAt = at() }, () => { entry.failed = true })
          return lease
        },
        deliver: (channel, value: any) => {
          if (channel === 'audio:progressiveStreamChunk') append(value)
          if (channel === 'audio:progressiveStreamEvent' && value.type === 'complete') {
            send({ type: 'set-source-ended', sessionId: value.sessionId, ended: true })
          }
        } })
    let currentId = 0, nextId: number | null = null, transitioned = false, transitionAt: number | null = null
    let ended = false
    const stalls: Array<{ session: string; atSeconds: number; seconds: number | null }> = []
    let lastReported = 0
    worklet.port.postMessage = (value: any) => {
      if (value.type === 'ended') ended = true
      if (value.type === 'gapless-transition') {
        transitioned = true; transitionAt = at()
        h.activate(value.sessionId)
        currentId = value.sessionId
        lastReported = 0
      }
      if (value.type === 'buffering') {
        const label = sessions.get(value.sessionId)?.slot ?? 'unknown'
        if (value.buffering) stalls.push({ session: label, atSeconds: at(), seconds: null })
        else { const open = stalls.findLast(stall => stall.seconds === null); if (open) open.seconds = at() - open.atSeconds }
      }
      if (value.type === 'position' && value.sessionId === currentId) {
        if (value.frame - lastReported >= RATE / 4 || !value.frame) { lastReported = value.frame; h.position(currentId, value.frame) }
        const state = sessions.get(currentId)!
        while (state.markers.length && state.markers[0].frame <= value.frame) {
          const marker = state.markers.shift()
          state.played.push({ atSeconds: at(), trackSeconds: marker.frame / RATE, quality: marker.quality.requested })
        }
      }
    }
    const result: any = { scenario: scenario.name, route: scenario.route, quality: scenario.quality, profile: link.profile }
    const art: number[] = [], artFailures: string[] = []
    let artPending: Promise<unknown> = Promise.resolve()
    if (scenario.art) {
      const download = (n: number) => (signal?: AbortSignal) =>
        fetch(`http://127.0.0.1:${link.ports.art}/art/${index}-${n}`, { signal }).then(response => response.arrayBuffer())
      artPending = Promise.allSettled(Array.from({ length: config.artCount ?? 24 }, (_, n) =>
        (scenario.art === 'priority' ? priority.run(download(n)) : download(n)()).then(() => { art.push(at()) },
          error => { artFailures.push(error instanceof Error ? `${error.message} ${(error as any).cause?.code ?? ''}`.trim() : String(error)) })))
      await delay(config.artLeadMs ?? 2000)
    }
    try {
      const started = performance.now()
      result.clickedAtSeconds = at()
      const info = await h.startOptions(paths[0], RATE, 2, { streamingQuality: scenario.quality, startTimeSeconds: 0, slot: 'current' })
      result.transport = info.transport ?? info.quality?.transport ?? null
      result.startupMs = { infoMs: performance.now() - started }
      currentId = info.sessionId
      sessions.set(currentId, { slot: 'current', markers: [], played: [], frames: 0 })
      send({ type: 'set-session', sessionId: currentId })
      append({ ...info.initialChunk, sessionId: currentId })
      h.position(currentId, 0)
      await until(() => worklet.totalFrames >= RATE * .75 || undefined, 'No playable startup buffer.', 120_000)
      send({ type: 'set-playing', playing: true })
      result.startupMs.playingMs = performance.now() - started
      const playUntil = config.playSeconds ?? durations[0]
      const nextUntil = config.nextSeconds ?? 20
      const playbackBegan = performance.now()
      let nextRequested = false, headroomAt: number | null = null
      const deadline = performance.now() + (playUntil + nextUntil + 240) * 1000
      for (;;) {
        assert.ok(performance.now() < deadline, 'Scenario exceeded its deadline.')
        const failed = h.events.find((event: any) => event.type === 'failed' && event.sessionId === currentId)
        if (failed) { result.failure = (failed as any).message ?? 'failed'; break }
        const due = Math.floor((performance.now() - playbackBegan) * RATE / 1000)
        while (renderedFrames() < due && !ended) render(Math.min(512, due - renderedFrames()))
        // Production schedules the next remote track once the current has 5 s of
        // PCM headroom, after a 1 s settle (playerStore ADAPTIVE_PREBUFFER_SETTLE_MS).
        if (scenario.next && !nextRequested && !transitioned) {
          const session = h.sessions.get(currentId)
          const headroom = session ? (session.decodedFrames - session.consumedFrames) / RATE : 0
          if (headroom >= 5 || session?.done) headroomAt ??= performance.now()
          if (headroomAt !== null && performance.now() - headroomAt >= 1000) {
            nextRequested = true
            const nextStarted = performance.now()
            void h.startOptions(paths[1], RATE, 2, { streamingQuality: scenario.quality, startTimeSeconds: 0, slot: 'next' })
              .then(next => {
                nextId = next.sessionId
                result.nextStartupMs = performance.now() - nextStarted
                result.nextRequestedAtSeconds = (nextStarted - began) / 1000
                sessions.set(nextId, { slot: 'next', markers: [], played: [], frames: 0 })
                send({ type: 'stage-next', sessionId: nextId })
                append({ ...next.initialChunk, sessionId: nextId })
                send({ type: 'set-next-ready', sessionId: nextId, ready: true })
              }, error => { result.nextFailure = error instanceof Error ? error.message : 'failed' })
          }
        }
        // Track position, not the output clock: starvation does not advance it.
        const position = worklet.currentFrame / RATE
        if (ended || (transitioned && transitionAt !== null && at() - transitionAt >= nextUntil)) break
        if (!transitioned && position >= playUntil && (!scenario.next || config.playSeconds)) break
        await delay(10)
      }
      result.outputSeconds = renderedFrames() / RATE
      result.transitioned = transitioned
    } catch (error) {
      result.failure = error instanceof Error ? error.message : String(error)
    } finally {
      // A scenario can end (or fail) while still buffering: count that time too.
      for (const stall of stalls) if (stall.seconds === null) Object.assign(stall, { seconds: at() - stall.atSeconds, unfinished: true })
      result.stalls = stalls
      result.fallbacks = fallbacks
      result.sessions = [...sessions].map(([id, state]) => ({ slot: state.slot, played: state.played, decodedSeconds: state.frames / RATE,
        diagnostics: h.diagnostics(id) ?? null }))
      result.events = h.events.filter(event => ['complete', 'failed', 'cancelled'].includes(event.type))
        .map((event: any) => ({ type: event.type, slot: sessions.get(event.sessionId)?.slot, message: event.message }))
      result.requests = requests
      if (scenario.art) {
        await Promise.race([artPending, delay(120_000)])
        result.art = { count: config.artCount ?? 24, completedAtSeconds: art, failures: artFailures }
      }
      result.conventional = conventional
      result.link = link.stats()
      await h.close()
      await retained.close(); await disk.close()
      await rm(join(work, `cache-${index}`), { recursive: true, force: true })
    }
    return result
  }
}

function summary(result: any) {
  const stalls = (result.stalls ?? []).filter((stall: any) => stall.session !== 'unknown')
  const segments = (result.requests ?? []).filter((request: any) => request.kind === 'segment')
  const opens = (result.requests ?? []).filter((request: any) => request.kind === 'open')
  const played = (result.sessions ?? []).flatMap((session: any) => session.played.map((value: any) => `${session.slot[0]}:${value.quality}@${value.trackSeconds.toFixed(0)}`))
  return {
    scenario: result.scenario, transport: result.transport, failure: result.failure ?? null,
    firstPcmMs: Math.round(result.startupMs?.infoMs ?? NaN), playingMs: Math.round(result.startupMs?.playingMs ?? NaN),
    openMs: opens[0] ? Math.round(opens[0].totalMs) : null,
    stalls: stalls.length, stallSeconds: +stalls.reduce((sum: number, stall: any) => sum + (stall.seconds ?? 0), 0).toFixed(1),
    firstStallAt: stalls[0] ? +stalls[0].atSeconds.toFixed(1) : null,
    nextAt: result.nextRequestedAtSeconds != null ? +result.nextRequestedAtSeconds.toFixed(1) : null,
    handoff: result.transitioned ?? false,
    played: played.join(' '), segments: segments.length,
    segmentMedianMs: segments.length ? Math.round(segments.map((s: any) => s.totalMs).sort((a: number, b: number) => a - b)[Math.floor(segments.length / 2)]) : null,
    connections: result.link?.connections?.length ?? null,
    downQueueP95Ms: Math.round(result.link?.down?.queueDelayMs?.p95 ?? NaN), fallbacks: (result.fallbacks ?? []).length,
    artDone: result.art ? `${result.art.completedAtSeconds.length}/${result.art.count} by ${(result.art.completedAtSeconds.at(-1) ?? NaN).toFixed?.(1)} s` : null
  }
}

main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1 })
  .finally(async () => {
    for (const value of children) value.kill('SIGTERM')
    await delay(1500)
    for (const value of children) if (value.exitCode === null) value.kill('SIGKILL')
    clearTimeout(watchdog)
  })
