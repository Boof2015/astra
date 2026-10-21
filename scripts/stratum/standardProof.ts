/** Run explicitly with ASTRA_STRATUM_SIDECAR pointing at checkpoint B's binary.
 * No Electron, audio device, existing database or real credentials are used. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { mainHarness } from './mainHarness.ts'
import { StratumAudioCache } from '../../src/main/services/stratumAudioCache.ts'
import { RemoteAudioCache } from '../../src/main/services/remoteAudioCache.ts'
import { analyzeRemoteAudioPcm, analyzeRemoteAudioFile } from '../../src/main/services/remoteAudioAnalysis.ts'
import { stratumProofRequest } from '../../src/main/services/stratumProofTransport.ts'
import type { StratumConnections } from '../../src/main/services/stratumConnections.ts'
import { StratumProofPcm, decodeStratumProofSegment } from '../../src/main/services/stratumProofPlayback.ts'
import { AutomaticStreamingQuality, type AudioTransferEvent } from '../../src/main/services/automaticStreamingQuality.ts'
import type { RemoteStreamInfo, RemoteAudioLoadProgress } from '../../src/types/remoteStream.ts'

const binary = process.env.ASTRA_STRATUM_SIDECAR
assert.ok(binary, 'Set ASTRA_STRATUM_SIDECAR to the checkpoint B sidecar-access binary.')
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, message: string, ms = 15000) {
  const end = Date.now() + ms
  while (!check()) { assert.ok(Date.now() < end, message); await delay(10) }
}
function wav(rate: number, seconds = 9): Buffer {
  const frames = rate * seconds + 317
  const bytes = Buffer.alloc(44 + frames * 4)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22)
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 4, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 4, 40)
  for (let frame = 0; frame < frames; frame++) {
    bytes.writeInt16LE(Math.round(9000 * Math.sin(frame * 2 * Math.PI * 317 / rate)), 44 + frame * 4)
    bytes.writeInt16LE(Math.round(7000 * Math.sin(frame * 2 * Math.PI * 911 / rate)), 46 + frame * 4)
  }
  return bytes
}

test('authenticated Stratum → actual Astra Standard session → real worklet, silently', { timeout: 110000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-stratum-standard-'))
  const fixtures = new Map([['r44100', wav(44100)], ['r48000', wav(48000)], ['r96000', wav(96000)], ['long', wav(48000, 40)], ['adaptive', wav(48000, 120)]])
  let deny = false, unavailable = false, reads = 0
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const values = new URLSearchParams(Buffer.concat(chunks).toString())
    const reply = (value: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ 'subsonic-response': value })) }
    if (values.get('u') !== 'listener' || values.get('t') !== 'a'.repeat(32)) return reply({ status: 'failed', error: { code: 40 } })
    if (req.url?.endsWith('ping.view')) return reply({ status: 'ok' })
    if (deny) return reply({ status: 'failed', error: { code: 50 } })
    if (unavailable) { res.writeHead(503); res.end(); return }
    const bytes = fixtures.get(values.get('id') ?? '')
    if (!bytes) return reply({ status: 'failed', error: { code: 70 } })
    if (req.url?.endsWith('getSong.view')) return reply({ status: 'ok', song: { id: values.get('id'), size: bytes.length } })
    assert.ok(req.url?.endsWith('stream.view'))
    if (req.headers.range) {
      res.writeHead(206, { 'content-type': 'audio/wav', 'content-range': `bytes 0-0/${bytes.length}` }); res.end(bytes.subarray(0, 1))
    } else { reads++; res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': bytes.length }); res.end(bytes) }
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()) }))
  const configPath = join(directory, 'sidecar.json')
  await writeFile(configPath, JSON.stringify({ upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, run_seconds: 120 }), { mode: 0o600 })
  const service = spawn(binary!, ['--config', configPath], { env: { ...process.env, TMPDIR: directory }, stdio: ['ignore', 'pipe', 'ignore'] })
  const closed = once(service, 'close')
  const hardStop = setTimeout(() => service.kill('SIGKILL'), 115000)
  t.after(async () => {
    clearTimeout(hardStop)
    service.kill('SIGTERM')
    const force = setTimeout(() => service.kill('SIGKILL'), 3000)
    await closed
    clearTimeout(force)
    await rm(directory, { recursive: true, force: true })
  })
  let line = ''
  service.stdout.on('data', chunk => { line += chunk.toString() })
  await until(() => line.includes('\n'), 'Sidecar did not announce its loopback address.')
  const endpoint = JSON.parse(line.split('\n')[0]).listen as string
  const signIn = await fetch(`${endpoint}/access/v1/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'listener', token: 'a'.repeat(32), salt: 'disposable' }), signal: AbortSignal.timeout(3000) })
  assert.equal(signIn.status, 201)
  const session = (await signIn.json() as { session: string }).session
  const config = { endpoint, session, sourceId: 7, tracks: [...fixtures.keys()] }
  const h = mainHarness(config, ffmpeg)
  t.after(() => h.close())
  async function collect(info: RemoteStreamInfo): Promise<Buffer> {
    assert.equal(info.transport, 'stratum-proof'); assert.equal(info.seekableCache, false); assert.equal(info.restartable, true)
    const tick = setInterval(() => h.ready(info.sessionId), 5)
    try {
      h.ready(info.sessionId)
      await until(() => h.events.some(e => e.sessionId === info.sessionId && (e.type === 'complete' || e.type === 'failed')), 'PCM session did not finish.')
      const last = h.events.find(e => e.sessionId === info.sessionId && e.type === 'failed')
      assert.equal(last, undefined, JSON.stringify(last))
      return Buffer.concat([Buffer.from(info.initialChunk!.pcmData), ...h.chunks.filter(c => c.sessionId === info.sessionId).map(c => Buffer.from(c.pcmData))])
    } finally { clearInterval(tick) }
  }
  const rendered: Buffer[] = []
  for (const rate of [44100, 48000, 96000]) {
    const track = `r${rate}`
    const path = join(directory, `${track}.wav`); await writeFile(path, fixtures.get(track)!)
    const info = await h.start(track, 48000)
    const pcm = await collect(info)
    const reference = execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-af', 'aresample=48000:resampler=swr:exact_rational=1:async=0:dither_method=none',
      '-f', 'f32le', 'pipe:1'], { maxBuffer: 8 * 1024 * 1024, timeout: 5000 })
    assert.equal(pcm.length, Math.floor((rate * 9 + 317) * 48000 / rate) * 8)
    assert.deepEqual(pcm, reference.subarray(0, pcm.length), `lossless ${rate} native frames differ`)
    const diagnostic = h.diagnostics(info.sessionId)
    assert.equal(diagnostic.state, 'complete', 'diagnostics survive decoder EOF until audible EOF')
    assert.equal(diagnostic.localCacheComplete, false, 'Stratum segments are not a retained local file')
    assert.equal(diagnostic.segments.length, 3)
    assert.ok(diagnostic.segments.every((segment: { state: string; payloadBytes: number }) => segment.state === 'decoded' && segment.payloadBytes > 0))
    assert.ok(!JSON.stringify(diagnostic).includes(session), 'diagnostics must not contain a bearer')
    rendered.push(pcm)
    for (const quality of [64, 128] as const) {
      const lossy = await collect(await h.start(track, 48000, quality))
      assert.equal(lossy.length, pcm.length, `${rate} / Opus ${quality} changed duration`)
      // Measure alignment inside each independently decoded interval, not just
      // its length. A duplicated pre-skip or displaced trim shifts this minimum.
      for (const second of [1, 5, 8]) {
        const errors = Array.from({ length: 17 }, (_, index) => {
          const shift = index - 8
          let error = 0
          for (let frame = second * 48000; frame < second * 48000 + 3000; frame++) {
            for (let channel = 0; channel < 2; channel++) {
              const difference = lossy.readFloatLE(frame * 8 + channel * 4) - pcm.readFloatLE((frame + shift) * 8 + channel * 4)
              error += difference * difference
            }
          }
          return error
        })
        assert.equal(errors.indexOf(Math.min(...errors)) - 8, 0, `${rate} / Opus ${quality} displaced the interval at ${second}s`)
      }
    }
    const seek = await h.start(track, 48000, 'original', 1.234567)
    const sought = await collect(seek)
    const first = Math.floor(Math.floor(1.234567 * rate) * 48000 / rate)
    assert.deepEqual(sought, reference.subarray(first * 8, first * 8 + sought.length), `seek at ${rate} lost resampler phase`)
  }
  // Installed route with the real retained cache/decoder/scanner. The transport
  // here points only at the disposable authenticated Sidecar above.
  let cacheOffline = false, cacheRequests = 0, analyses = 0
  const disk = new RemoteAudioCache(join(directory, 'cache'), 64 * 1024 ** 2, {
    analyze: async () => { throw new Error('Segment sent to file scanner.') }, ready: () => { analyses++ }
  })
  const retained = new StratumAudioCache(disk, {
    decode: (segment, signal) => decodeStratumProofSegment(ffmpeg, segment, signal),
    scan: (source, pcm, signal) => analyzeRemoteAudioPcm(ffmpeg, source, pcm, signal)
  })
  const approved = { scope: 'disposable-approved-account', connection: { endpoint, signal: new AbortController().signal,
    getBearer: async () => session, reject() {},
    request: ((...args: Parameters<typeof stratumProofRequest> extends [string, ...infer R] ? R : never) => {
      cacheRequests++
      if (cacheOffline) return Promise.reject(new Error('Offline fixture'))
      return stratumProofRequest(endpoint, ...args)
    })
  } }
  const installed = { cachedConnection: () => approved, playbackStarted() {}, playbackFailed() { throw new Error('Unexpected Stratum fallback') } } as unknown as StratumConnections
  const aheadObservations: number[] = []
  class CachedPolicy extends AutomaticStreamingQuality {
    override recommend(...args: Parameters<AutomaticStreamingQuality['recommend']>) {
      aheadObservations.push(args[2].segments?.aheadSeconds ?? 0)
      return super.recommend(...args)
    }
  }
  const cacheProgress: RemoteAudioLoadProgress[] = []
  const cached = mainHarness(config, ffmpeg, { installed, cache: retained, policy: new CachedPolicy(),
    deliver: (channel, value) => { if (channel === 'audio:progressiveLoadProgress') cacheProgress.push(value as RemoteAudioLoadProgress) } })
  t.after(async () => { await cached.close(); await retained.close(); await disk.close() })
  async function cachedCollect(track: string, quality: 'original' | 64 | 128, seek = 0) {
    const info = await cached.start(track, 48000, quality, seek)
    assert.equal(info.quality?.transport, 'stratum')
    assert.equal(info.quality?.requested, quality)
    assert.ok(info.quality?.analysisKey)
    const tick = setInterval(() => cached.ready(info.sessionId), 2)
    try {
      await until(() => cached.events.some(e => e.sessionId === info.sessionId && ['failed', 'complete'].includes(e.type)), 'Cached audio did not finish.')
      assert.equal(cached.events.some(e => e.sessionId === info.sessionId && e.type === 'failed'), false)
      const pcm = Buffer.concat([Buffer.from(info.initialChunk!.pcmData), ...cached.chunks.filter(c => c.sessionId === info.sessionId).map(c => Buffer.from(c.pcmData))])
      // Completion retains the group through audible EOF, until the renderer releases it.
      assert.ok(cached.sessions.has(info.sessionId))
      await disk.clearUnused()
      assert.ok((await disk.status()).activeBytes > 0)
      return { info, pcm }
    } finally { clearInterval(tick); await cached.cancel(info.sessionId) }
  }
  for (const [i, rate] of [44100, 48000, 96000].entries()) {
    const track = `r${rate}`
    const first = await cachedCollect(track, 'original')
    assert.deepEqual(first.pcm, rendered[i], 'cache changed original decoded samples')
    assert.equal(first.info.quality?.loudness, undefined, 'first listen must not change gain midway')
    await until(() => analyses === i + 1, 'Retained analysis did not finish')
    const full = await disk.getAnalysis(first.info.quality!.analysisKey!)
    const reference = await analyzeRemoteAudioFile(join(directory, `${track}.wav`), ffmpeg,
      createRequire(import.meta.url)('ffprobe-static').path, AbortSignal.timeout(10000))
    assert.ok(full)
    assert.equal(full.loudnessLufs, reference.loudnessLufs)
    assert.equal(full.peakLinear, reference.peakLinear)
    const waveformError = Math.max(...full.peaks.map((peak, bin) => Math.abs(peak - reference.peaks[bin])))
    // ffprobe rounds duration to microseconds; a bin boundary can move by one 8 kHz sample.
    assert.ok(waveformError < .005, `PCM/file waveform difference at ${rate}: ${waveformError}`)
    cacheOffline = true
    const before = cacheRequests
    const sought = await cachedCollect(track, 'original', 1.234567)
    const offset = Math.floor(Math.floor(1.234567 * rate) * 48000 / rate)
    assert.deepEqual(sought.pcm, rendered[i].subarray(offset * 8, offset * 8 + sought.pcm.length), 'canonical cache seek lost phase')
    assert.equal(cacheRequests, before, 'warm seek must make no server or authentication requests')
    assert.equal(sought.info.quality?.loudness?.loudnessLufs, reference.loudnessLufs)
    cacheOffline = false
  }
  for (const quality of [64, 128] as const) {
    const first = await cachedCollect('r48000', quality)
    await until(() => analyses === (quality === 64 ? 4 : 5), 'Opus analysis did not finish')
    cacheOffline = true
    const before = cacheRequests
    const warm = await cachedCollect('r48000', quality)
    assert.deepEqual(warm.pcm, first.pcm)
    assert.equal(cacheRequests, before)
    assert.ok(warm.info.quality?.loudness)
    assert.equal(warm.info.quality?.requestedCodec, 'opus')
    cacheOffline = false
  }

  // Reproduce the real limitation: the listener stays at zero while the PCM
  // buffer reaches its cap. Encoded fetching and waveform analysis must still
  // finish the entire two-minute track; memory remains bounded by backpressure.
  const heldCached = await cached.start('adaptive', 48000, 'automatic')
  cached.ready(heldCached.sessionId, false)
  const heldSession = cached.sessions.get(heldCached.sessionId)!
  await until(() => heldSession.stratum.cacheComplete, 'Fetching stopped at the PCM lookahead limit.')
  await until(() => analyses === 6, 'Full waveform analysis waited for playback consumption.')
  await until(() => cacheProgress.some(progress => progress.sessionId === heldCached.sessionId && progress.analysisReady === true),
    'Completed Stratum analysis never reached ongoing progress for the current listen.')
  const readyProgress = cacheProgress.find(progress => progress.sessionId === heldCached.sessionId && progress.analysisReady === true)!
  assert.equal(readyProgress.quality?.analysisKey, heldCached.quality?.analysisKey)
  assert.equal(readyProgress.quality?.loudness, undefined)
  assert.equal(readyProgress.done, false)
  assert.equal(heldSession.consumedFrames, 0)
  assert.ok(heldSession.decodedFrames <= 32 * 48000, `unbounded PCM: ${heldSession.decodedFrames}`)
  assert.ok(heldSession.decodedFrames < heldSession.stratum.interval.frames)
  assert.ok(aheadObservations.some(ahead => ahead > 60), 'automatic quality must see encoded cache beyond the PCM cap')
  assert.ok(await disk.getAnalysis(heldCached.quality!.analysisKey!))
  assert.equal(heldCached.quality?.loudness, undefined, 'analysis must not change first-listen gain')
  await heldSession.stratum.release()
  const fetchedRequests = cacheRequests
  const fetchedBytes = heldSession.loadedBytes
  cacheOffline = true
  const heldTick = setInterval(() => cached.ready(heldCached.sessionId), 2)
  try {
    await until(() => cached.events.some(e => e.sessionId === heldCached.sessionId && ['complete', 'failed'].includes(e.type)), 'Retained playback did not drain.')
    assert.ok(!cached.events.some(e => e.sessionId === heldCached.sessionId && e.type === 'failed'))
    const decoded = Buffer.concat([Buffer.from(heldCached.initialChunk!.pcmData),
      ...cached.chunks.filter(c => c.sessionId === heldCached.sessionId).map(c => Buffer.from(c.pcmData))])
    const original = fixtures.get('adaptive')!.subarray(44)
    assert.equal(decoded.length, original.length * 2)
    for (let sample = 0; sample < original.length / 2; sample++) {
      assert.equal(decoded.readFloatLE(sample * 4), original.readInt16LE(sample * 2) / 32768, `changed sample ${sample}`)
    }
    assert.equal(cacheRequests, fetchedRequests, 'draining retained audio must not contact Sidecar')
    assert.equal(heldSession.loadedBytes, fetchedBytes, 'decode reads must not count as new downloads')
  } finally { clearInterval(heldTick); await cached.cancel(heldCached.sessionId); cacheOffline = false }

  // Fetching later qualities must not move the audible-quality marker early.
  const scheduled = mainHarness(config, ffmpeg, { installed, cache: retained,
    segmentQuality: seconds => seconds < 40 || seconds >= 80 ? 'lossless' : 'opus-64' })
  t.after(() => scheduled.close())
  const scheduledInfo = await scheduled.start('adaptive', 48000)
  await until(() => {
    const tail = scheduled.diagnostics(scheduledInfo.sessionId)?.segments.at(-1)
    return !!tail && tail.end > 120 && ['received', 'decoded'].includes(tail.state)
  }, 'Scheduled qualities did not fetch ahead of the held decoder.')
  assert.equal(scheduledInfo.quality?.requested, 'original')
  assert.ok(!scheduled.chunks.some(c => c.qualityChanges?.some(change => change.quality.requested === 64)))
  const scheduledTick = setInterval(() => scheduled.ready(scheduledInfo.sessionId), 2)
  try {
    await until(() => scheduled.events.some(e => ['complete', 'failed'].includes(e.type)), 'Scheduled cached PCM did not finish.')
    assert.ok(!scheduled.events.some(e => e.type === 'failed'))
    const changes = [scheduledInfo.initialChunk!, ...scheduled.chunks].flatMap(c => c.qualityChanges ?? [])
    assert.deepEqual(changes.map(change => [change.frame, change.quality.requested]), [[0, 'original'], [40 * 48000, 64], [80 * 48000, 'original']])
  } finally { clearInterval(scheduledTick); await scheduled.close() }
  console.log('Fetch-ahead proof: full 120-second cache and waveform with listener held at zero, bounded PCM, exact offline drain, correct quality markers.')
  await cached.close(); await retained.close(); await disk.close()

  // Real worklet natural handoff with the delivered PCM, crossing native clocks.
  let Processor: any
  runInNewContext(readFileSync(new URL('../../src/renderer/public/oscilloscope-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: () => {} } },
    registerProcessor: (name: string, value: unknown) => { if (name === 'remote-stream-player') Processor = value },
    Float32Array, sampleRate: 48000, currentFrame: 0
  })
  const worklet = new Processor({ outputChannelCount: [2], processorOptions: { discardConsumedChunks: true } })
  const send = (data: unknown) => worklet.port.onmessage({ data })
  const pair = [rendered[0], rendered[2]]
  pair.forEach((pcm, i) => {
    send({ type: i ? 'stage-next' : 'set-session', sessionId: i + 1 })
    send({ type: 'append-chunk', sessionId: i + 1, frameCount: pcm.length / 8,
      interleavedData: new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length)) })
    send({ type: 'set-source-ended', sessionId: i + 1, ended: true })
  })
  send({ type: 'set-next-ready', sessionId: 2, ready: true }); send({ type: 'set-playing', playing: true })
  const frames = (pair[0].length + pair[1].length) / 8
  const left = new Float32Array(frames), right = new Float32Array(frames)
  worklet.process([], [[left, right]])
  const expected = Buffer.concat(pair)
  for (let i = 0; i < frames; i++) { assert.equal(left[i], expected.readFloatLE(i * 8)); assert.equal(right[i], expected.readFloatLE(i * 8 + 4)) }

  // Controlled choices independently check interval markers and the converter.
  const pcm = await StratumProofPcm.open(config, 'r44100', 48000, 0, new AbortController().signal)
  const converter = spawn(ffmpeg, pcm.converterArgs(), { stdio: ['pipe', 'pipe', 'ignore'] })
  const converted: Buffer[] = []; converter.stdout.on('data', chunk => converted.push(chunk))
  const converterClosed = once(converter, 'close')
  try {
    await pcm.feed(converter.stdin, ffmpeg, AbortSignal.timeout(15000), start => start < 44100 * 4 ? 'lossless' : start < 44100 * 8 ? 'opus-64' : 'opus-128')
    assert.equal((await converterClosed)[0], 0)
    await pcm.verifyComplete(Buffer.concat(converted).length / 8)
    assert.deepEqual(pcm.takeQualityChanges(Infinity).map(change => [change.frame, change.quality.requested]),
      [[0, 'original'], [4 * 48000, 64], [8 * 48000, 128]])
  } finally { converter.kill('SIGKILL'); await pcm.release() }

  // Real authenticated segments/decoding/main sessions; deterministic transfer
  // measurements and consumption simulate a slowdown/recovery without a real
  // device or minutes of wall-clock sleeping. This is not a WAN benchmark.
  for (const mode of ['automatic', 'automatic-original'] as const) {
    let clock = 0, requests = 0
    class MeasuredPolicy extends AutomaticStreamingQuality {
      override observer(key: string, minimum = 250) {
        const observe = super.observer(key, minimum)
        let kbps = 0
        return (event: AudioTransferEvent) => {
          if (event.phase === 'start') { requests++; kbps = requests <= 6 ? 80 : 8000; clock += 4000 }
          if (event.phase === 'data') clock += (event.bytes ?? 0) * 8 / kbps
          observe(event)
        }
      }
    }
    const adaptive = mainHarness(config, ffmpeg, { policy: new MeasuredPolicy(() => clock) })
    try {
      const info = await adaptive.start('adaptive', 44100, mode)
      const tick = setInterval(() => {
        const session = adaptive.sessions.get(info.sessionId)
        if (session) adaptive.position(info.sessionId, Math.max(0, session.decodedFrames - 44100 * 10))
      }, 2)
      try {
        await until(() => adaptive.events.some(e => e.type === 'complete' || e.type === 'failed'), 'Automatic PCM did not finish.', 25000)
      } catch (error) {
        const active = adaptive.sessions.get(info.sessionId)
        const diagnostic = adaptive.diagnostics(info.sessionId)
        throw new Error(`${String(error)} ${JSON.stringify({ decodedFrames: active?.decodedFrames, consumedFrames: active?.consumedFrames,
          paused: active?.stdoutPausedForBackpressure, pending: active?.pendingOutcome?.outcome, lastSegment: diagnostic?.segments.at(-1) })}`)
      }
      finally { clearInterval(tick) }
      assert.ok(!adaptive.events.some(e => e.type === 'failed'))
      const chunks = [info.initialChunk!, ...adaptive.chunks]
      const changes = chunks.flatMap(chunk => chunk.qualityChanges ?? [])
      assert.equal(changes[0].quality.requested, 'original')
      assert.ok(changes.some(change => change.quality.requested === 64), JSON.stringify(changes))
      assert.equal(changes.at(-1)!.quality.requested, 'original', JSON.stringify(changes))
      assert.ok(changes.every(change => change.quality.mode === mode))
      assert.ok(changes.every((change, index) => !index || change.frame > changes[index - 1].frame))
      assert.equal(chunks.reduce((frames, chunk) => frames + chunk.frameCount, 0), Math.floor((48000 * 120 + 317) * 44100 / 48000))
      assert.equal(adaptive.events.filter(e => e.type === 'started').length, 1, 'automatic changes must keep the same PCM session')
    } finally { await adaptive.close() }
    const sought = await h.start('r44100', 48000, { mode, target: 64 }, 1.234567)
    const soughtPcm = await collect(sought)
    assert.equal(sought.quality?.mode, mode)
    assert.equal(sought.quality?.requested, 64, 'a seek retains its pinned initial representation')
    assert.equal(sought.initialChunk?.qualityChanges?.[0].frame, 0, 'seek pre-roll must not offset the initial readout')
    assert.equal(soughtPcm.length, Math.floor((44100 * 9 + 317 - Math.floor(1.234567 * 44100)) * 48000 / 44100) * 8)
  }

  // A held consumer bounds PCM; a denial/outage after that cannot turn failure
  // into EOF or conventional-cache playback, nor emit stale chunks after cancel.
  const held = await h.start('long', 48000)
  h.ready(held.sessionId, false)
  await until(() => h.sessions.get(held.sessionId)?.stdoutPausedForBackpressure === true, 'Backpressure never paused the converter.')
  assert.ok(h.sessions.get(held.sessionId).decodedFrames <= 48000 * 30 + 4096)
  await h.cancel(held.sessionId)
  const delivered = h.chunks.length
  await delay(100)
  assert.equal(h.chunks.length, delivered)
  const current = await h.start('long', 48000)
  const next = await h.start('r44100', 48000, 64, 0, 'next')
  await h.cancel(current.sessionId)
  const sought = await h.start('long', 48000, 'original', 7.12345)
  assert.ok(h.sessions.has(next.sessionId), 'Seeking current must retain the prepared successor.')
  assert.notEqual(current.sessionId, sought.sessionId)
  await h.cancel(sought.sessionId); await h.cancel(next.sessionId)
  for (const kind of ['denial', 'outage']) {
    const active = await h.start('long', 48000)
    h.ready(active.sessionId, false)
    await until(() => h.sessions.get(active.sessionId)?.decodedFrames >= 48000 * 30, 'Did not reach held buffer.')
    if (kind === 'denial') deny = true; else unavailable = true
    const tick = setInterval(() => h.ready(active.sessionId), 5)
    try { await until(() => h.events.some(e => e.sessionId === active.sessionId && e.type === 'failed'), 'Missing failure event.') }
    finally { clearInterval(tick); deny = false; unavailable = false; await h.cancel(active.sessionId) }
    assert.equal(h.events.some(e => e.sessionId === active.sessionId && e.type === 'complete'), false)
  }
  assert.ok(reads >= 12)
  assert.equal(h.sessions.size, 0)
  assert.equal(h.sender.listenerCount('destroyed'), 0)
  t.diagnostic('44.1/48/96 kHz lossless, Opus 64/128, exact seeks, mixed-rate worklet handoff, scheduled and automatic quality changes (simulated transfer timing), seek quality markers, backpressure, cancellation, denial and outage passed; no audio device opened.')
})
