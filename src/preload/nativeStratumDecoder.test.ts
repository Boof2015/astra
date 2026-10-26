import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { startNativeStratumDecoder } from './nativeStratumDecoder.ts'
import type { NativeProgressiveInput } from '../types/nativeProgressive.ts'
import type { NativeRemoteSource } from '../types/nativeRemoteSource.ts'

function fixture() {
  const origin = 44100 * 5 + 7, capacity = 44100
  let published = origin, retained = origin, state: 'open' | 'ended' | 'cancelled' = 'open'
  const bytes: Buffer[] = []
  const input = { append: (data: Uint8Array) => {
    const frames = Math.min(data.length / 8, capacity - (published - retained))
    bytes.push(Buffer.from(data.subarray(0, frames * 8))); published += frames; return frames
  }, status: () => ({ sessionId: 1, startFrame: origin, retainedFrame: retained, publishedFrame: published,
    capacityFrames: capacity, sampleRate: 44100, bytesPerFrame: 8, state }),
  cancel: () => { state = 'cancelled' }, finish: () => { state = 'ended'; return true }
  } as NativeProgressiveInput
  const expected = Buffer.alloc(44100 * 3 * 8)
  for (let i = 0; i < expected.length; i++) expected[i] = i % 251
  let offset = 0, reads = 0, releases = 0
  const source = { release() { releases++ }, finished: async () => {}, pcm: {
    read: async () => { reads++; if (offset === expected.length) return null
      const data = Uint8Array.from(expected.subarray(offset, offset + 65536)).buffer
      offset += data.byteLength; return data }
  } } as unknown as NativeRemoteSource
  return { input, source, expected, bytes, counters: () => ({ reads, releases }), consume: () => { retained = published } }
}

test('Stratum PCM keeps exact native frames across partial appends and bounded paused input', async () => {
  const f = fixture(), stop = new AbortController()
  const decoder = startNativeStratumDecoder(f.source, f.input, stop.signal, error => assert.fail(error.message))
  await decoder.ready
  await delay(30)
  const reads = f.counters().reads
  await delay(30)
  assert.equal(f.counters().reads, reads, 'a full paused ring must stop pulling IPC packets')
  assert.ok(decoder.pendingBytes <= 65536)
  const drain = setInterval(f.consume, 5)
  try { await decoder.done } finally { clearInterval(drain); stop.abort() }
  assert.deepEqual(Buffer.concat(f.bytes), f.expected)
  assert.equal(f.input.status().publishedFrame - f.input.status().startFrame, 44100 * 3)
})

test('cancel stops a pending IPC read without waiting for more audio', async () => {
  const f = fixture(), stop = new AbortController()
  let rejectRead!: (error: Error) => void
  f.source.pcm!.read = () => new Promise((_resolve, reject) => { rejectRead = reject })
  f.source.release = () => rejectRead(new Error('released'))
  const decoder = startNativeStratumDecoder(f.source, f.input, stop.signal, () => assert.fail('cancel must not report a playback failure'))
  stop.abort()
  await assert.rejects(decoder.ready, { name: 'AbortError' })
  await assert.rejects(decoder.done, { name: 'AbortError' })
  assert.equal(f.input.status().state, 'cancelled')
})

test('Stratum EOF validation failure never finishes native input', async () => {
  const f = fixture(), failures: Error[] = []
  f.source.finished = async () => { throw new Error('truncated interval') }
  const decoder = startNativeStratumDecoder(f.source, f.input, new AbortController().signal, error => failures.push(error))
  const drain = setInterval(f.consume, 5)
  try { await assert.rejects(decoder.done, /truncated interval/) } finally { clearInterval(drain) }
  assert.equal(f.input.status().state, 'open')
  assert.equal(failures.length, 1)
})
