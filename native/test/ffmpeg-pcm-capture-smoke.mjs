import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const nativeCapture = require('../build/Release/ffmpeg_pcm_capture.node')
const ffmpegPath = require('ffmpeg-static')

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

async function waitFor(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await delay(10)
  }
  assert.fail(`Timed out waiting for ${description}.`)
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function waitForNewPid(existingPids, description) {
  return await waitFor(
    () => nativeCapture.getActiveProcessIds().find((pid) => !existingPids.has(pid)),
    description,
  )
}

async function waitForPidExit(pid) {
  await waitFor(() => !isPidAlive(pid), `PID ${pid} to exit`)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function spawnCollect(executable, args) {
  return await new Promise((resolveChild, rejectChild) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.once('error', rejectChild)
    child.once('close', (code, signal) => {
      resolveChild({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

function request(jobId, slotId, executable, args) {
  return { jobId, slotId, ffmpegPath: executable, args }
}

function realtimeArgs(frequency) {
  return [
    '-v', 'error',
    '-nostdin',
    '-re',
    '-f', 'lavfi',
    '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=30`,
    '-map', '0:a:0',
    '-vn',
    '-acodec', 'pcm_f32le',
    '-f', 'f32le',
    '-ar', '48000',
    'pipe:1',
  ]
}

test('bundled FFmpeg native capture smoke', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'astra native capture smoke '))
  const copiedFfmpegPath = join(tempRoot, 'ffmpeg copy with spaces.exe')
  const sourcePath = join(tempRoot, 'source input with spaces.wav')
  const pendingCaptures = new Set()

  const trackCapture = (promise) => {
    pendingCaptures.add(promise)
    promise.finally(() => pendingCaptures.delete(promise))
    return promise
  }

  try {
    await copyFile(ffmpegPath, copiedFfmpegPath)
    const generated = await spawnCollect(ffmpegPath, [
      '-v', 'error',
      '-nostdin',
      '-f', 'lavfi',
      '-i', 'sine=frequency=997:sample_rate=48000:duration=0.35',
      '-c:a', 'pcm_s16le',
      sourcePath,
    ])
    assert.equal(generated.code, 0, generated.stderr)

    const decodeArgs = [
      '-v', 'error',
      '-nostdin',
      '-i', sourcePath,
      '-map', '0:a:0',
      '-vn',
      '-acodec', 'pcm_f32le',
      '-f', 'f32le',
      '-ar', '48000',
      'pipe:1',
    ]
    const ordinary = await spawnCollect(copiedFfmpegPath, decodeArgs)
    assert.equal(ordinary.code, 0, ordinary.stderr)

    const parityResult = await nativeCapture.capture(request(
      'ffmpeg-parity-job',
      'ffmpeg-parity-slot',
      copiedFfmpegPath,
      decodeArgs,
    ))
    assert.equal(parityResult.ok, true, parityResult.errorMessage ?? parityResult.stderr)
    assert.equal(parityResult.exitCode, 0)
    assert.equal(parityResult.outputBytes, ordinary.stdout.length)
    assert.equal(parityResult.pcm.length, ordinary.stdout.length)
    assert.equal(sha256(parityResult.pcm), sha256(ordinary.stdout))
    console.log('[native-smoke] parity', JSON.stringify({
      executablePath: copiedFfmpegPath,
      inputPath: sourcePath,
      bytes: parityResult.pcm.length,
      sha256: sha256(parityResult.pcm),
      nativeProcessMs: parityResult.processMs,
      nativeSpawnMs: parityResult.spawnMs,
      nativeFirstByteMs: parityResult.firstByteMs,
      nativeReadSpanMs: parityResult.stdoutReadSpanMs,
      nativeReadCount: parityResult.stdoutReadCount,
      nativeReadMinBytes: parityResult.stdoutReadMinBytes,
      nativeReadMaxBytes: parityResult.stdoutReadMaxBytes,
      requestedPipeBufferBytes: parityResult.requestedPipeBufferBytes,
      effectivePipeBufferBytes: parityResult.effectivePipeBufferBytes,
    }))

    const invalidResult = await nativeCapture.capture(request(
      'ffmpeg-invalid-job',
      'ffmpeg-invalid-slot',
      join(tempRoot, 'missing ffmpeg.exe'),
      decodeArgs,
    ))
    assert.equal(invalidResult.ok, false)
    assert.equal(invalidResult.cancelled, false)
    assert.equal(invalidResult.errorCode, 'spawn_failed')
    assert.equal(invalidResult.outputBytes, 0)
    assert.equal(invalidResult.pcm.length, 0)
    console.log('[native-smoke] invalid-input', JSON.stringify({
      errorCode: invalidResult.errorCode,
      windowsErrorCode: invalidResult.windowsErrorCode,
      outputBytes: invalidResult.outputBytes,
      pcmLength: invalidResult.pcm.length,
    }))

    const invalidMediaResult = await nativeCapture.capture(request(
      'ffmpeg-invalid-media-job',
      'ffmpeg-invalid-media-slot',
      copiedFfmpegPath,
      [
        '-v', 'error',
        '-nostdin',
        '-i', join(tempRoot, 'missing source with spaces.flac'),
        '-map', '0:a:0',
        '-vn',
        '-acodec', 'pcm_f32le',
        '-f', 'f32le',
        '-ar', '48000',
        'pipe:1',
      ],
    ))
    assert.equal(invalidMediaResult.ok, false)
    assert.equal(invalidMediaResult.cancelled, false)
    assert.equal(invalidMediaResult.errorCode, 'nonzero_exit')
    assert.notEqual(invalidMediaResult.exitCode, 0)
    assert.notEqual(invalidMediaResult.stderr.length, 0)
    assert.equal(invalidMediaResult.outputBytes, 0)
    assert.equal(invalidMediaResult.pcm.length, 0)
    console.log('[native-smoke] invalid-media', JSON.stringify({
      exitCode: invalidMediaResult.exitCode,
      errorCode: invalidMediaResult.errorCode,
      stderrBytes: Buffer.byteLength(invalidMediaResult.stderr),
      outputBytes: invalidMediaResult.outputBytes,
      pcmLength: invalidMediaResult.pcm.length,
    }))

    const beforeCancel = new Set(nativeCapture.getActiveProcessIds())
    const cancelPromise = trackCapture(nativeCapture.capture(request(
      'ffmpeg-cancel-job',
      'ffmpeg-cancel-slot',
      ffmpegPath,
      realtimeArgs(431),
    )))
    const cancelPid = await waitForNewPid(beforeCancel, 'cancellable FFmpeg PID')
    assert.equal(isPidAlive(cancelPid), true)
    assert.equal(nativeCapture.cancel('ffmpeg-cancel-job'), true)
    const cancelResult = await cancelPromise
    assert.equal(cancelResult.ok, false)
    assert.equal(cancelResult.cancelled, true)
    assert.equal(cancelResult.errorCode, 'cancelled')
    assert.ok(cancelResult.outputBytes >= 0)
    assert.equal(cancelResult.pcm.length, 0)
    await waitForPidExit(cancelPid)
    assert.equal(nativeCapture.getActiveProcessIds().includes(cancelPid), false)
    console.log('[native-smoke] cancellation', JSON.stringify({
      pid: cancelPid,
      survived: isPidAlive(cancelPid),
      errorCode: cancelResult.errorCode,
      outputBytes: cancelResult.outputBytes,
      pcmLength: cancelResult.pcm.length,
    }))

    const beforeReplacement = new Set(nativeCapture.getActiveProcessIds())
    const replacedPromise = trackCapture(nativeCapture.capture(request(
      'ffmpeg-replaced-job',
      'ffmpeg-shared-slot',
      ffmpegPath,
      realtimeArgs(541),
    )))
    const replacedPid = await waitForNewPid(beforeReplacement, 'superseded FFmpeg PID')
    const replacementPromise = trackCapture(nativeCapture.capture(request(
      'ffmpeg-replacement-job',
      'ffmpeg-shared-slot',
      ffmpegPath,
      realtimeArgs(647),
    )))
    const replacedResult = await replacedPromise
    assert.equal(replacedResult.cancelled, true)
    assert.ok(replacedResult.outputBytes >= 0)
    assert.equal(replacedResult.pcm.length, 0)
    await waitForPidExit(replacedPid)
    const replacementPid = await waitFor(
      () => nativeCapture.getActiveProcessIds().find((pid) => pid !== replacedPid),
      'replacement FFmpeg PID',
    )
    assert.equal(isPidAlive(replacementPid), true)
    assert.equal(nativeCapture.cancel('ffmpeg-replacement-job'), true)
    const replacementResult = await replacementPromise
    assert.equal(replacementResult.cancelled, true)
    await waitForPidExit(replacementPid)
    console.log('[native-smoke] same-slot', JSON.stringify({
      replacedPid,
      replacementPid,
      replacedSurvived: isPidAlive(replacedPid),
      replacementSurvived: isPidAlive(replacementPid),
    }))

    const concurrencyBaseline = new Set(nativeCapture.getActiveProcessIds())
    const firstConcurrent = trackCapture(nativeCapture.capture(request(
      'ffmpeg-concurrent-a',
      'ffmpeg-concurrent-slot-a',
      ffmpegPath,
      realtimeArgs(733),
    )))
    const firstConcurrentPid = await waitForNewPid(concurrencyBaseline, 'first concurrent FFmpeg PID')
    const secondBaseline = new Set(nativeCapture.getActiveProcessIds())
    const secondConcurrent = trackCapture(nativeCapture.capture(request(
      'ffmpeg-concurrent-b',
      'ffmpeg-concurrent-slot-b',
      ffmpegPath,
      realtimeArgs(839),
    )))
    const secondConcurrentPid = await waitForNewPid(secondBaseline, 'second concurrent FFmpeg PID')
    assert.notEqual(firstConcurrentPid, secondConcurrentPid)
    const visiblePids = nativeCapture.getActiveProcessIds()
    assert.equal(visiblePids.includes(firstConcurrentPid), true)
    assert.equal(visiblePids.includes(secondConcurrentPid), true)
    assert.equal(isPidAlive(firstConcurrentPid), true)
    assert.equal(isPidAlive(secondConcurrentPid), true)
    assert.equal(nativeCapture.cancel('ffmpeg-concurrent-a'), true)
    assert.equal(nativeCapture.cancel('ffmpeg-concurrent-b'), true)
    const [firstConcurrentResult, secondConcurrentResult] = await Promise.all([
      firstConcurrent,
      secondConcurrent,
    ])
    assert.equal(firstConcurrentResult.cancelled, true)
    assert.equal(secondConcurrentResult.cancelled, true)
    await Promise.all([
      waitForPidExit(firstConcurrentPid),
      waitForPidExit(secondConcurrentPid),
    ])
    assert.deepEqual(nativeCapture.getActiveProcessIds(), [])
    console.log('[native-smoke] concurrency', JSON.stringify({
      visiblePids,
      firstSurvived: isPidAlive(firstConcurrentPid),
      secondSurvived: isPidAlive(secondConcurrentPid),
      activeAfterCancel: nativeCapture.getActiveProcessIds(),
    }))
  } finally {
    nativeCapture.cancelAll()
    await Promise.allSettled([...pendingCaptures])
    const resolvedTempRoot = resolve(tempRoot)
    const resolvedTempParent = `${resolve(tmpdir())}${sep}`
    assert.equal(resolvedTempRoot.startsWith(resolvedTempParent), true)
    assert.equal(basename(resolvedTempRoot).startsWith('astra native capture smoke '), true)
    await rm(resolvedTempRoot, { recursive: true, force: true })
  }
})

test.after(() => {
  nativeCapture.cancelAll()
})
