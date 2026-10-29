import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { startNativePcmDecoder } from './nativePcmDecoder.ts'
import type { NativeProgressiveInput, NativeProgressiveInputStatus } from '../types/nativeProgressive.ts'

function fakeInput(capacityFrames = 4, stride = 4): NativeProgressiveInput & { played: Buffer[]; consume: () => void } {
  const state: NativeProgressiveInputStatus = {
    sessionId: 1, sampleRate: 48000, bytesPerFrame: stride, capacityFrames,
    startFrame: 0, retainedFrame: 0, publishedFrame: 0, state: 'open'
  }
  let pending = Buffer.alloc(0)
  const played: Buffer[] = []
  return {
    played,
    status: () => ({ ...state }),
    append: (bytes) => {
      assert.equal(bytes.byteLength % stride, 0)
      if (state.state !== 'open') return 0
      const accepted = Math.min(bytes.byteLength / stride, capacityFrames - state.publishedFrame + state.retainedFrame)
      pending = Buffer.concat([pending, Buffer.from(bytes.subarray(0, accepted * stride))])
      state.publishedFrame += accepted
      assert.ok(pending.length <= capacityFrames * stride)
      return accepted
    },
    consume: () => {
      played.push(pending)
      state.retainedFrame = state.publishedFrame
      pending = Buffer.alloc(0)
    },
    finish: () => { if (state.state !== 'open') return false; state.state = 'ended'; return true },
    cancel: () => { state.state = 'cancelled' },
    load: () => { throw new Error('Decoder must not start playback') },
    preloadNext: () => { throw new Error('Decoder must not prepare output') },
    seek: async () => { throw new Error('Decoder must not seek output') }
  }
}

function run(script: string, input = fakeInput(), extra: Partial<Parameters<typeof startNativePcmDecoder>[0]> = {}) {
  return { input, decoder: startNativePcmDecoder({
    command: process.execPath, args: ['-e', script], input, startupFrames: 2, idleTimeoutMs: 2000, ...extra
  }) }
}

test('partial appends and split frames retain every byte through bounded backpressure', async () => {
  const { input, decoder } = run(`
    const bytes = Buffer.from(Array.from({length: 1200}, (_, i) => i % 251));
    let offset = 0;
    const timer = setInterval(() => {
      const end = Math.min(bytes.length, offset + 7);
      process.stdout.write(bytes.subarray(offset, end)); offset = end;
      if (offset === bytes.length) clearInterval(timer);
    }, 1);
  `, fakeInput(17, 6))
  const consume = setInterval(() => input.consume(), 5)
  try {
    await decoder.ready
    await decoder.done
    input.consume()
    assert.deepEqual(Buffer.concat(input.played), Buffer.from(Array.from({ length: 1200 }, (_, i) => i % 251)))
    assert.equal(input.status().state, 'ended')
    assert.equal(decoder.pendingBytes, 0)
  } finally { clearInterval(consume); decoder.cancel() }
})

test('a full paused input waits without a decoder-idle error and cancellation terminates it', async t => {
  const { input, decoder } = run('process.stdout.write(Buffer.alloc(1024 * 1024))', fakeInput(4), { idleTimeoutMs: 1000 })
  t.after(decoder.cancel)
  await decoder.ready
  await delay(1100)
  assert.equal(input.status().publishedFrame, 4)
  assert.equal(input.status().state, 'open')
  assert.ok(decoder.pendingBytes > 0 && decoder.pendingBytes <= 256 * 1024 + 32)
  decoder.cancel()
  await assert.rejects(decoder.done, { name: 'AbortError' })
  assert.equal(input.status().state, 'cancelled')
})

test('successful short EOF waits for encoded-source validation before becoming ready', async () => {
  let validate!: () => void
  let entered!: () => void
  const validationEntered = new Promise<void>((resolve) => { entered = resolve })
  const validation = new Promise<void>((resolve) => { validate = resolve })
  const { input, decoder } = run('process.stdout.write(Buffer.alloc(4))', fakeInput(), {
    validateEof: () => { entered(); return validation }
  })
  let ready = false
  void decoder.ready.then(() => { ready = true })
  await validationEntered
  assert.equal(ready, false)
  assert.equal(input.status().state, 'open')
  validate()
  await decoder.ready
  await decoder.done
  assert.equal(input.status().state, 'ended')
})

test('failed/truncated/empty output never publishes decoder EOF or starts another track', async () => {
  for (const script of [
    'process.stdout.write(Buffer.alloc(12)); process.stderr.write("decode failed"); process.exitCode = 1',
    'process.stdout.write(Buffer.alloc(3))',
    ''
  ]) {
    let failures = 0
    const { input, decoder } = run(script, fakeInput(), { onFailure: () => { failures++ } })
    await assert.rejects(decoder.done)
    assert.equal(input.status().state, 'open')
    assert.equal(failures, 1)
  }
  const { input, decoder } = run('process.stdout.write(Buffer.alloc(8))', fakeInput(), {
    validateEof: async () => { throw new Error('Encoded download was truncated') }
  })
  await assert.rejects(decoder.done, /truncated/)
  assert.equal(input.status().state, 'open')
})

test('abort and native cancellation interrupt both idle reading and source validation', { timeout: 5000 }, async t => {
  // The cancellation monitor deliberately does not keep the app alive. Once the
  // child exits, this isolated test must supply the application's event-loop
  // lifetime while it waits for the monitor to observe native cancellation.
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  const controller = new AbortController()
  const waiting = run('setInterval(() => {}, 100)', fakeInput(), { signal: controller.signal })
  t.after(waiting.decoder.cancel)
  controller.abort()
  await assert.rejects(waiting.decoder.ready, { name: 'AbortError' })
  await assert.rejects(waiting.decoder.done, { name: 'AbortError' })
  let entered!: () => void
  const validationEntered = new Promise<void>((resolve) => { entered = resolve })
  const validating = run('process.stdout.write(Buffer.alloc(4))', fakeInput(), {
    validateEof: () => { entered(); return new Promise(() => {}) }
  })
  t.after(validating.decoder.cancel)
  await validationEntered
  validating.input.cancel() // Engine stop/replace cancels an attached native input.
  await assert.rejects(validating.decoder.done, { name: 'AbortError' })
})

test('missing executable, idle decoder, and invalid readiness budgets fail cleanly', async () => {
  assert.throws(() => run('', fakeInput(4), { startupFrames: 5 }), /buffering limits/)
  const missing = run('', fakeInput(), { command: '/astra-nonexistent-decoder' })
  await assert.rejects(missing.decoder.done, /ENOENT/)
  const idle = run('setInterval(() => {}, 100)', fakeInput(), { idleTimeoutMs: 100 })
  await assert.rejects(idle.decoder.done, /stopped producing audio/)
  assert.equal(idle.input.status().state, 'open')
})
