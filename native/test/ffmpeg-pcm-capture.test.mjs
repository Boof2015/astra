import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const nativeCapture = require('../build/Release/ffmpeg_pcm_capture.node')
const testNodeExecutable = process.env.ASTRA_TEST_NODE_EXECUTABLE || process.execPath

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  assert.fail('Timed out waiting for native capture state.')
}

function request(jobId, slotId, source, args = []) {
  return {
    jobId,
    slotId,
    ffmpegPath: testNodeExecutable,
    args: ['-e', source, ...args],
  }
}

test('exports a separate bounded main-process capture API', () => {
  assert.equal(typeof nativeCapture.getCapabilities, 'function')
  assert.equal(typeof nativeCapture.capture, 'function')
  assert.equal(typeof nativeCapture.acknowledge, 'function')
  assert.equal(typeof nativeCapture.cancel, 'function')
  assert.equal(typeof nativeCapture.cancelAll, 'function')
  assert.equal(typeof nativeCapture.getActiveProcessIds, 'function')

  const capabilities = nativeCapture.getCapabilities()
  assert.equal(capabilities.supported, process.platform === 'win32')
  assert.equal(capabilities.maxPcmBytes, 192 * 1024 * 1024)
  assert.equal(capabilities.requestedPipeBufferBytes, 1024 * 1024)
  assert.equal(capabilities.supportsProgressBatches, process.platform === 'win32')
  assert.equal(capabilities.progressBatchBytes, 8 * 1024 * 1024)
  assert.equal(capabilities.progressMaxInFlightBatches, 2)
})

test('validates executable requests synchronously', () => {
  assert.throws(
    () => nativeCapture.capture({ jobId: 'invalid', slotId: 'invalid', ffmpegPath: '', args: [] }),
    /ffmpegPath must be non-empty/,
  )
  assert.throws(
    () => nativeCapture.capture({ jobId: 'invalid', slotId: 'invalid', ffmpegPath: 'node', args: [1] }),
    /Every FFmpeg argument must be a string/,
  )
  assert.throws(
    () => nativeCapture.capture({
      jobId: 'invalid',
      slotId: 'invalid',
      ffmpegPath: 'node',
      args: [],
      deliveryMode: 'progress_batches',
    }),
    /requires an onBatch callback/,
  )
  assert.throws(
    () => nativeCapture.capture({
      jobId: 'invalid',
      slotId: 'invalid',
      ffmpegPath: 'node',
      args: [],
      deliveryMode: 'progress_batches',
      batchBytes: 1024,
    }, () => undefined),
    /batchBytes to equal 8 MiB/,
  )
  assert.throws(
    () => nativeCapture.capture({
      jobId: 'invalid',
      slotId: 'invalid',
      ffmpegPath: 'node',
      args: [],
      deliveryMode: 'complete_buffer',
    }, () => undefined),
    /does not accept an onBatch callback/,
  )
  assert.throws(() => nativeCapture.acknowledge('invalid', -1), /non-negative safe integer/)
})

test('captures exact binary stdout and stderr with Windows argument quoting', {
  skip: process.platform !== 'win32',
}, async () => {
  const payload = 'spaces, a \\ slash, a " quote, and a trailing slash \\'
  const result = await nativeCapture.capture(request(
    'success-job',
    'success-slot',
    'process.stdout.write(Buffer.from(process.argv[1], "utf8")); process.stderr.write("stderr-marker")',
    [payload],
  ))

  assert.equal(result.ok, true)
  assert.equal(result.jobId, 'success-job')
  assert.equal(result.cancelled, false)
  assert.equal(result.exitCode, 0)
  assert.equal(result.errorCode, null)
  assert.equal(result.errorMessage, null)
  assert.equal(result.windowsErrorCode, null)
  assert.equal(result.stderr, 'stderr-marker')
  assert.equal(result.stderrTruncated, false)
  assert.equal(Buffer.isBuffer(result.pcm), true)
  assert.equal(result.pcm.toString('utf8'), payload)
  assert.equal(result.outputBytes, Buffer.byteLength(payload))
  assert.ok(result.stdoutReadCount >= 1)
  assert.ok(result.stdoutReadMinBytes >= 1)
  assert.ok(result.stdoutReadMaxBytes >= result.stdoutReadMinBytes)
  assert.ok(result.stdoutReadMaxBytes <= 1024 * 1024)
  assert.equal(result.requestedPipeBufferBytes, 1024 * 1024)
  assert.ok(result.effectivePipeBufferBytes === null || result.effectivePipeBufferBytes > 0)
  assert.ok(result.spawnMs >= 0)
  assert.ok(result.firstByteMs >= result.spawnMs)
  assert.ok(result.stdoutReadSpanMs >= 0)
  assert.ok(result.processMs >= result.firstByteMs)
  assert.equal(typeof result.usedExternalBuffer, 'boolean')
  assert.ok(result.bufferCopyMs >= 0)
  assert.equal(result.deliveryMode, 'complete_buffer')
  assert.equal(result.batchTargetBytes, 8 * 1024 * 1024)
  assert.equal(result.batchCount, 0)
  assert.equal(result.batchBytes, 0)
  assert.equal(result.batchMinBytes, null)
  assert.equal(result.batchMaxBytes, null)
  assert.equal(result.batchCreditWaitCount, 0)
  assert.equal(result.batchCreditWaitMs, 0)
  assert.equal(result.batchCreditWaitMaxMs, 0)
  assert.equal(result.batchCopyMs, 0)
  assert.equal(result.batchCopyMaxMs, 0)
  assert.equal(result.batchCallbackMs, 0)
  assert.equal(result.batchCallbackMaxMs, 0)
  if (process.versions.electron) {
    assert.equal(result.usedExternalBuffer, false)
  }
})

test('streams owned 8 MiB progress batches with two-credit backpressure', {
  skip: process.platform !== 'win32',
  timeout: 30000,
}, async () => {
  const batchBytes = 8 * 1024 * 1024
  const totalBytes = (batchBytes * 2) + (2 * 1024 * 1024) + 123
  const source = `
    const totalBytes = ${totalBytes};
    const chunk = Buffer.alloc(1024 * 1024, 0x5a);
    let written = 0;
    function pump() {
      while (written < totalBytes) {
        const remaining = totalBytes - written;
        const payload = remaining < chunk.length ? chunk.subarray(0, remaining) : chunk;
        written += payload.length;
        if (!process.stdout.write(payload)) {
          process.stdout.once('drain', pump);
          return;
        }
      }
    }
    pump();
  `
  const batches = []
  let automaticallyAcknowledge = false
  let settled = false
  const capturePromise = nativeCapture.capture({
    ...request('progress-job', 'progress-slot', source),
    deliveryMode: 'progress_batches',
    batchBytes,
  }, (batch) => {
    assert.equal(batch.jobId, 'progress-job')
    assert.equal(Buffer.isBuffer(batch.payload), true)
    batches.push(batch)
    if (automaticallyAcknowledge) {
      assert.equal(nativeCapture.acknowledge(batch.jobId, batch.sequence), true)
    }
  }).then((result) => {
    settled = true
    return result
  })

  await waitFor(() => batches.length === 2)
  await delay(75)
  assert.equal(batches.length, 2)
  assert.equal(settled, false)
  assert.equal(nativeCapture.acknowledge('progress-job', 1), false)
  assert.equal(nativeCapture.acknowledge('progress-job', 0), true)
  assert.equal(nativeCapture.acknowledge('progress-job', 0), false)
  await waitFor(() => batches.length === 3)

  automaticallyAcknowledge = true
  assert.equal(nativeCapture.acknowledge('progress-job', 1), true)
  assert.equal(nativeCapture.acknowledge('progress-job', 2), true)
  const result = await capturePromise

  assert.equal(result.ok, true)
  assert.equal(result.deliveryMode, 'progress_batches')
  assert.equal(result.outputBytes, totalBytes)
  assert.equal(result.pcm.length, 0)
  assert.equal(result.usedExternalBuffer, false)
  assert.equal(result.bufferCopyMs, 0)
  assert.equal(result.batchTargetBytes, batchBytes)
  assert.equal(result.batchCount, 3)
  assert.equal(result.batchBytes, totalBytes)
  assert.equal(result.batchMinBytes, totalBytes - (batchBytes * 2))
  assert.equal(result.batchMaxBytes, batchBytes)
  assert.ok(result.batchCreditWaitCount >= 1)
  assert.ok(result.batchCreditWaitCount <= result.batchCount)
  assert.ok(result.batchCreditWaitMs >= 50)
  assert.ok(result.batchCreditWaitMaxMs >= 50)
  assert.ok(result.batchCopyMs >= 0)
  assert.ok(result.batchCopyMaxMs >= 0)
  assert.ok(result.batchCallbackMs >= 0)
  assert.ok(result.batchCallbackMaxMs >= 0)
  assert.deepEqual(batches.map((batch) => batch.sequence), [0, 1, 2])
  assert.deepEqual(batches.map((batch) => batch.byteOffset), [0, batchBytes, batchBytes * 2])
  assert.deepEqual(batches.map((batch) => batch.byteLength), [
    batchBytes,
    batchBytes,
    totalBytes - (batchBytes * 2),
  ])
  const joined = Buffer.concat(batches.map((batch) => batch.payload))
  assert.equal(joined.length, totalBytes)
  assert.equal(joined.every((byte) => byte === 0x5a), true)
  assert.equal(nativeCapture.acknowledge('progress-job', 2), false)
})

test('cancellation wakes a capture blocked behind queued progress batches', {
  skip: process.platform !== 'win32',
  timeout: 15000,
}, async () => {
  const source = `
    process.stdout.on('error', () => process.exit(0));
    const chunk = Buffer.alloc(1024 * 1024, 0x33);
    function pump() {
      while (process.stdout.write(chunk)) {}
      process.stdout.once('drain', pump);
    }
    pump();
  `
  const sequences = []
  const capturePromise = nativeCapture.capture({
    ...request('progress-cancel-job', 'progress-cancel-slot', source),
    deliveryMode: 'progress_batches',
  }, (batch) => {
    sequences.push(batch.sequence)
  })

  await waitFor(() => sequences.length === 2)
  await delay(50)
  assert.deepEqual(sequences, [0, 1])
  assert.equal(nativeCapture.cancel('progress-cancel-job'), true)
  const result = await capturePromise
  const callbacksAtSettlement = sequences.length
  await delay(50)

  assert.equal(result.ok, false)
  assert.equal(result.cancelled, true)
  assert.equal(result.errorCode, 'cancelled')
  assert.equal(result.deliveryMode, 'progress_batches')
  assert.equal(result.pcm.length, 0)
  assert.equal(sequences.length, callbacksAtSettlement)
  assert.equal(nativeCapture.acknowledge('progress-cancel-job', 0), false)
  assert.deepEqual(nativeCapture.getActiveProcessIds(), [])
})

test('cancellation suppresses a progress descriptor already queued behind the first callback', {
  skip: process.platform !== 'win32',
  timeout: 15000,
}, async () => {
  const source = `
    process.stdout.on('error', () => process.exit(0));
    const chunk = Buffer.alloc(1024 * 1024, 0x66);
    function pump() {
      while (process.stdout.write(chunk)) {}
      process.stdout.once('drain', pump);
    }
    pump();
  `
  const sequences = []
  const capturePromise = nativeCapture.capture({
    ...request('queued-cancel-job', 'queued-cancel-slot', source),
    deliveryMode: 'progress_batches',
  }, (batch) => {
    sequences.push(batch.sequence)
    if (batch.sequence === 0) {
      assert.equal(nativeCapture.cancel(batch.jobId), true)
    }
  })

  // Hold the JS thread long enough for the native worker to dispatch both
  // credits and block behind them before OnProgress admits sequence zero.
  const blockedUntil = Date.now() + 150
  while (Date.now() < blockedUntil) {
    // Intentional deterministic event-loop stall for this queue/cancel race.
  }

  const result = await capturePromise
  assert.equal(result.cancelled, true)
  assert.ok(result.outputBytes >= 2 * 8 * 1024 * 1024)
  assert.deepEqual(sequences, [0])
  assert.equal(result.batchCount, 1)
  assert.equal(result.batchBytes, 8 * 1024 * 1024)
  assert.equal(result.batchMinBytes, 8 * 1024 * 1024)
  assert.equal(result.batchMaxBytes, 8 * 1024 * 1024)
  assert.equal(result.pcm.length, 0)
  assert.deepEqual(nativeCapture.getActiveProcessIds(), [])
})

test('a throwing progress callback terminates capture without an uncaught exception', {
  skip: process.platform !== 'win32',
  timeout: 15000,
}, async () => {
  const source = `
    process.stdout.on('error', () => process.exit(0));
    process.stdout.write(Buffer.alloc(9 * 1024 * 1024, 0x44));
  `
  const result = await nativeCapture.capture({
    ...request('progress-throw-job', 'progress-throw-slot', source),
    deliveryMode: 'progress_batches',
  }, () => {
    throw new Error('consumer exploded')
  })

  assert.equal(result.ok, false)
  assert.equal(result.cancelled, false)
  assert.equal(result.errorCode, 'batch_callback_failed')
  assert.match(result.errorMessage, /consumer exploded/)
  assert.equal(result.pcm.length, 0)
  assert.deepEqual(nativeCapture.getActiveProcessIds(), [])
})

test('preserves nonzero exit and stderr while discarding partial PCM', {
  skip: process.platform !== 'win32',
}, async () => {
  const result = await nativeCapture.capture(request(
    'nonzero-job',
    'nonzero-slot',
    'process.stdout.write("partial"); process.stderr.write("decode failed"); process.exit(7)',
  ))

  assert.equal(result.ok, false)
  assert.equal(result.cancelled, false)
  assert.equal(result.exitCode, 7)
  assert.equal(result.errorCode, 'nonzero_exit')
  assert.match(result.errorMessage, /code 7/)
  assert.equal(result.stderr, 'decode failed')
  assert.equal(result.outputBytes, Buffer.byteLength('partial'))
  assert.equal(result.pcm.length, 0)
  assert.equal(result.usedExternalBuffer, false)
  assert.equal(result.bufferCopyMs, 0)
})

test('reports exact spawn failures without losing the Windows error code', {
  skip: process.platform !== 'win32',
}, async () => {
  const result = await nativeCapture.capture({
    jobId: 'missing-executable',
    slotId: 'missing-executable-slot',
    ffmpegPath: 'Z:\\astra-does-not-exist\\ffmpeg.exe',
    args: [],
  })

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'spawn_failed')
  assert.equal(result.processId, null)
  assert.equal(result.exitCode, null)
  assert.equal(typeof result.windowsErrorCode, 'number')
  assert.ok(result.windowsErrorCode > 0)
  assert.equal(result.outputBytes, 0)
  assert.equal(result.pcm.length, 0)
})

test('cancellation and latest-wins are scoped by slotId', {
  skip: process.platform !== 'win32',
  timeout: 15000,
}, async () => {
  const keepAliveSource = 'setInterval(() => process.stdout.write(Buffer.alloc(4096, 1)), 10)'
  const replaced = nativeCapture.capture(request('replace-old', 'shared-slot', keepAliveSource))
  await waitFor(() => nativeCapture.getActiveProcessIds().length === 1)
  assert.throws(
    () => nativeCapture.capture(request('replace-old', 'different-slot', keepAliveSource)),
    /already uses this jobId/,
  )

  const unrelated = nativeCapture.capture(request('unrelated', 'other-slot', keepAliveSource))
  await waitFor(() => nativeCapture.getActiveProcessIds().length === 2)

  const replacement = nativeCapture.capture(request(
    'replace-new',
    'shared-slot',
    'process.stdout.write("replacement")',
  ))

  const replacedResult = await replaced
  const replacementResult = await replacement
  assert.equal(replacedResult.cancelled, true)
  assert.equal(replacedResult.errorCode, 'cancelled')
  assert.ok(replacedResult.outputBytes >= 0)
  assert.equal(replacedResult.pcm.length, 0)
  assert.equal(replacementResult.ok, true)
  assert.equal(replacementResult.pcm.toString(), 'replacement')

  assert.equal(nativeCapture.cancel('unrelated'), true)
  const unrelatedResult = await unrelated
  assert.equal(unrelatedResult.cancelled, true)
  assert.equal(unrelatedResult.errorCode, 'cancelled')
  assert.equal(nativeCapture.cancel('unrelated'), false)
  assert.deepEqual(nativeCapture.getActiveProcessIds(), [])
})

test('enforces the hard 192 MiB PCM cap without returning partial data', {
  skip: process.platform !== 'win32',
  timeout: 30000,
}, async () => {
  const source = `
    process.stdout.on('error', () => process.exit(0));
    const chunk = Buffer.alloc(1024 * 1024, 3);
    let count = 0;
    function pump() {
      while (count < 193) {
        count += 1;
        if (!process.stdout.write(chunk)) {
          process.stdout.once('drain', pump);
          return;
        }
      }
    }
    pump();
  `
  const result = await nativeCapture.capture(request('limit-job', 'limit-slot', source))

  assert.equal(result.ok, false)
  assert.equal(result.cancelled, false)
  assert.equal(result.errorCode, 'pcm_limit_exceeded')
  assert.equal(result.outputBytes, 192 * 1024 * 1024)
  assert.equal(result.pcm.length, 0)
  assert.ok(result.stdoutReadCount > 0)
})

test.after(() => {
  nativeCapture.cancelAll()
})
