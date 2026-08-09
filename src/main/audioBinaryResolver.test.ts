import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createCachedAudioBinaryResolver,
  type AudioBinaryName
} from './audioBinaryResolver.ts'

test('coalesces concurrent binary lookups and caches successful paths per tool', async () => {
  const calls: AudioBinaryName[] = []
  let finishFfmpeg: ((path: string) => void) | undefined
  const resolveBinary = createCachedAudioBinaryResolver((binary) => {
    calls.push(binary)
    if (binary === 'ffmpeg') {
      return new Promise((resolve) => {
        finishFfmpeg = resolve
      })
    }
    return Promise.resolve('/test/ffprobe')
  })

  const first = resolveBinary('ffmpeg')
  const second = resolveBinary('ffmpeg')
  assert.strictEqual(second, first)
  assert.deepEqual(calls, ['ffmpeg'])

  finishFfmpeg?.('/test/ffmpeg')
  assert.deepEqual(await Promise.all([first, second]), ['/test/ffmpeg', '/test/ffmpeg'])
  assert.equal(await resolveBinary('ffmpeg'), '/test/ffmpeg')
  assert.equal(await resolveBinary('ffprobe'), '/test/ffprobe')
  assert.deepEqual(calls, ['ffmpeg', 'ffprobe'])
})

test('caches an unavailable null result instead of treating it as unresolved', async () => {
  let calls = 0
  const resolveBinary = createCachedAudioBinaryResolver(async () => {
    calls += 1
    return null
  })

  assert.equal(await resolveBinary('ffmpeg'), null)
  assert.equal(await resolveBinary('ffmpeg'), null)
  assert.equal(calls, 1)
})

test('shares a rejected lookup but leaves it unresolved for a later retry', async () => {
  const temporaryFailure = new Error('temporary lookup failure')
  let calls = 0
  let rejectFirst: ((error: Error) => void) | undefined
  const resolveBinary = createCachedAudioBinaryResolver(() => {
    calls += 1
    if (calls === 1) {
      return new Promise((_resolve, reject) => {
        rejectFirst = reject
      })
    }
    return Promise.resolve('/test/ffmpeg')
  })

  const first = resolveBinary('ffmpeg')
  const second = resolveBinary('ffmpeg')
  assert.strictEqual(second, first)
  assert.equal(calls, 1)

  rejectFirst?.(temporaryFailure)
  const failures = await Promise.allSettled([first, second])
  assert.deepEqual(failures, [
    { status: 'rejected', reason: temporaryFailure },
    { status: 'rejected', reason: temporaryFailure }
  ])

  assert.equal(await resolveBinary('ffmpeg'), '/test/ffmpeg')
  assert.equal(await resolveBinary('ffmpeg'), '/test/ffmpeg')
  assert.equal(calls, 2)
})
