import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import ts from 'typescript'
import { ProgressiveStartupRegistry } from './progressiveStartupRegistry.ts'
import { ProgressivePcmDelivery } from './progressivePcmDelivery.ts'
import { withRemoteCompatibility, RemoteCompatibilityFailure, isUnsupportedRemoteDecoder } from '../shared/audio/remoteCompatibility.ts'
import { deliveredAudioFormat, type StreamingQualityRequest } from '../types/streamingQuality.ts'

// Exercise the actual main-process lifecycle without booting Electron or opening
// the user's library. Only OS/IPC/cache boundaries are substituted.
const names = ['startProgressiveStreamSession', 'startProgressiveStreamAttempt', 'finalizeRemoteStreamSession',
  'settleRemoteStreamStartup', 'pumpRemoteStreamOutput', 'flushRemoteStreamOutput', 'emitRemoteStreamChunk',
  'cancelProgressiveStreamSession', 'isRemoteStreamPipeTeardownError']
const source = ts.createSourceFile('index.ts', readFileSync(new URL('./index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const declarations = source.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? ''))
assert.equal(declarations.length, names.length)
const javascript = ts.transpileModule(declarations.map(node => node.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText

function harness(fail: (attempt: number) => string | null, holdRetry = false) {
  const requests: Array<StreamingQualityRequest | undefined> = [], released: number[] = [], events: any[] = []
  const sessions = new Map(), registry = new ProgressiveStartupRegistry()
  let resume!: () => void
  let count = 0
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false,
    send: (_channel: string, payload: unknown) => { events.push(payload) } })
  const context = {
    Buffer, AbortController, setInterval, clearInterval, ProgressivePcmDelivery, isDev: false,
    withRemoteCompatibility, RemoteCompatibilityFailure, isUnsupportedRemoteDecoder, deliveredAudioFormat,
    remoteStreamSessions: sessions, progressiveStartupControllers: registry,
    library: { getTrackByPath: () => ({ channels: 2 }) }, resolveBinary: async (name: string) => name,
    resolveProgressiveStreamSourceType: (path: string) => path.startsWith('/') ? 'local' : 'subsonic',
    normalizeProgressiveStartTimeSeconds: (value: number) => value ?? 0, resolveRemoteTrackDurationSeconds: () => 60,
    safeSendRemoteLoadProgress: (_session: unknown, stage: string) => { events.push({ stage }) },
    safeSendRemoteStreamEvent: (_session: unknown, payload: unknown) => { events.push(payload) },
    updateLocalProgressiveStreamBackpressure() {}, toStandaloneArrayBuffer: (data: Buffer) => new Uint8Array(data).buffer,
    REMOTE_STREAM_CHUNK_FRAMES: 4096, LOCAL_STREAM_STARTUP_CHUNK_FRAMES: 8192,
    LOCAL_STREAM_STEADY_AFTER_SECONDS: 1, LOCAL_STREAM_STEADY_CHUNK_FRAMES: 65536,
    execFileAsync: async () => JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'flac', channels: 2, sample_rate: '48000' }] }),
    acquireCachedRemoteAudio: async (_path: string, signal: AbortSignal, request: StreamingQualityRequest | undefined) => {
      requests.push(request)
      const id = requests.length
      if (holdRetry && id === 2) await new Promise<void>(resolve => { resume = resolve })
      const compatibility = typeof request === 'object' ? request.compatibility : undefined
      return { url: 'http://cache/secret-capability', quality: { requested: 'original', requestedCodec: compatibility ?? null, compatibility, delivered: null },
        progress: () => ({ complete: true, loadedBytes: 100, totalBytes: 100 }),
        finished: async () => { signal.throwIfAborted() }, release: () => { released.push(id) } }
    },
    spawn: () => {
      const diagnostic = fail(++count)
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        killed: false, kill() { this.killed = true; this.stdout.destroy(); this.stderr.destroy() } })
      setImmediate(() => {
        if (child.killed) return
        if (diagnostic) { child.stderr.write(diagnostic); child.stdout.end(); child.emit('close', 1) }
        else child.stdout.write(Buffer.alloc(8192 * 8))
      })
      return child
    }
  }
  const api = new Function(...Object.keys(context), `let nextRemoteStreamSessionId = 1;\n${javascript}\nreturn { start: startProgressiveStreamSession, cancel: cancelProgressiveStreamSession }`)(...Object.values(context))
  return { api, sender, registry, requests, released, events, sessions, resume: () => resume() }
}

const unsupported = 'Decoder (codec ac4) not found for input stream #0:0'
const path = 'subsonic://1/song'

test('Standard retries an unsupported decoder without a failed event, then releases the compatible session normally', async () => {
  const h = harness(attempt => attempt === 1 ? unsupported : null)
  const result = await h.api.start(h.sender, path, 48000, 2, { startTimeSeconds: 10 })
  assert.deepEqual(h.requests, [undefined, { target: 'original', compatibility: 'flac' }])
  assert.equal(result.quality.compatibility, 'flac')
  assert.equal(result.quality.delivered.codec, 'flac')
  assert.equal(result.startTimeSeconds, 10)
  assert.equal(result.initialChunk.frameCount, 4096)
  assert.deepEqual(h.released, [1])
  assert.equal(h.events.some(event => event.type === 'failed' || event.stage === 'failed'), false)
  await h.api.cancel(result.sessionId)
  assert.deepEqual(h.released, [1, 2])
  assert.equal(h.sessions.size, 0)
  assert.equal(h.sender.listenerCount('destroyed'), 0)
})

test('Standard stops after bounded compatibility attempts and leaves no sessions or sender hooks', async () => {
  const h = harness(() => `${unsupported} http://cache/secret-capability`)
  await assert.rejects(h.api.start(h.sender, path, 48000), (error: Error) => {
    assert.ok(!error.message.includes('secret-capability'))
    return true
  })
  assert.deepEqual(h.requests, [undefined, { target: 'original', compatibility: 'flac' }, { target: 'original', compatibility: 'opus' }, { target: 'original', compatibility: 'mp3' }])
  assert.deepEqual(h.released, [1, 2, 3, 4])
  assert.equal(h.sessions.size, 0)
  assert.equal(h.sender.listenerCount('did-start-navigation'), 0)
})

for (const cancel of ['skip', 'navigation'] as const) {
  test(`Standard ${cancel} cancels a pending conversion without replacing playback`, async () => {
    const h = harness(() => unsupported, true)
    const pending = h.api.start(h.sender, path, 48000)
    const rejected = assert.rejects(pending, { name: 'AbortError' })
    while (h.requests.length < 2) await new Promise(resolve => setImmediate(resolve))
    if (cancel === 'skip') h.registry.cancel(1, 'current')
    else h.sender.emit('did-start-navigation', {}, 'url', false, true)
    h.resume()
    await rejected
    assert.deepEqual(h.released, [1, 2])
    assert.equal(h.sessions.size, 0)
    assert.equal(h.sender.listenerCount('destroyed'), 0)
  })
}

test('Standard network/corrupt-media failures and local decoder failures never request conversion', async () => {
  for (const [file, diagnostic] of [[path, 'Invalid data found when processing input'], [path, 'HTTP error 401 Unauthorized'], ['/local.flac', unsupported]]) {
    const h = harness(() => diagnostic)
    await assert.rejects(h.api.start(h.sender, file, 48000))
    assert.equal(h.requests.length, file === path ? 1 : 0)
    assert.ok(h.events.some(event => event.type === 'failed'))
    assert.equal(h.sessions.size, 0)
  }
})

test('a cancelled Standard decoder cannot flush leftover PCM on a late stdout end', async () => {
  const h = harness(() => null)
  const info = await h.api.start(h.sender, path, 48000)
  const session = h.sessions.get(info.sessionId)
  session.rendererReady = true
  session.pcmDelivery.drain()
  session.pcmDelivery.push(Buffer.alloc(40))
  await h.api.cancel(info.sessionId)
  const before = h.events.length
  session.ffmpeg.stdout.emit('end')
  assert.equal(h.events.length, before, 'late EOF must not emit an obsolete partial PCM chunk')
})
