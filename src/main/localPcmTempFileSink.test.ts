import assert from 'node:assert/strict'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildLocalPcmFfmpegOutputArgs,
  cleanupLocalPcmTempFileSink,
  createLocalPcmTempFileSink,
  readLocalPcmTempFileIntoBuffer,
  statBoundedLocalPcmTempFile
} from './localPcmTempFileSink.ts'

test('keeps stdout pipe as the default and bounds temporary FFmpeg output', () => {
  assert.deepEqual(buildLocalPcmFfmpegOutputArgs(null, 192 * 1024 * 1024), ['pipe:1'])
  assert.deepEqual(
    buildLocalPcmFfmpegOutputArgs({
      directoryPath: 'C:\\temp\\astra-local-pcm-test',
      outputPath: 'C:\\temp\\astra-local-pcm-test\\decoded.f32le'
    }, 16),
    ['-fs', '17', 'C:\\temp\\astra-local-pcm-test\\decoded.f32le']
  )
})

async function makeTestRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'astra-local-pcm-test-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return root
}

test('creates request-owned output paths and cleans them idempotently', async (t) => {
  const root = await makeTestRoot(t)
  const first = await createLocalPcmTempFileSink(root)
  const second = await createLocalPcmTempFileSink(root)

  assert.notEqual(first.directoryPath, second.directoryPath)
  assert.equal(first.outputPath, join(first.directoryPath, 'decoded.f32le'))
  await writeFile(first.outputPath, Buffer.from([1, 2, 3, 4]))

  const firstCleanup = cleanupLocalPcmTempFileSink(first)
  assert.equal(cleanupLocalPcmTempFileSink(first), firstCleanup)
  assert.deepEqual(await firstCleanup, { succeeded: true, error: null })
  await assert.rejects(access(first.directoryPath))
  assert.equal((await cleanupLocalPcmTempFileSink(second)).succeeded, true)
})

test('validates the completed file size before a large read', async (t) => {
  const root = await makeTestRoot(t)
  const sink = await createLocalPcmTempFileSink(root)

  await writeFile(sink.outputPath, Buffer.alloc(16, 7))
  assert.equal(await statBoundedLocalPcmTempFile(sink, 16), 16)
  await assert.rejects(
    statBoundedLocalPcmTempFile(sink, 15),
    /192 MiB Standard playback limit/
  )

  await writeFile(sink.outputPath, Buffer.alloc(0))
  await assert.rejects(statBoundedLocalPcmTempFile(sink, 16), /produced no decoded audio/)
  await cleanupLocalPcmTempFileSink(sink)
})

test('reads the exact validated prefix directly into the destination', async (t) => {
  const root = await makeTestRoot(t)
  const sink = await createLocalPcmTempFileSink(root)
  const expected = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  await writeFile(sink.outputPath, expected)
  const destination = Buffer.alloc(16, 0xff)

  const result = await readLocalPcmTempFileIntoBuffer(
    sink,
    destination,
    expected.byteLength,
    { chunkBytes: 3 }
  )

  assert.deepEqual(result, { byteLength: 10, chunkCount: 4 })
  assert.deepEqual(destination.subarray(0, 10), expected)
  assert.deepEqual(destination.subarray(10), Buffer.alloc(6, 0xff))
  await cleanupLocalPcmTempFileSink(sink)
})

test('rejects early EOF and never reports a partial read as complete', async (t) => {
  const root = await makeTestRoot(t)
  const sink = await createLocalPcmTempFileSink(root)
  await writeFile(sink.outputPath, Buffer.from([1, 2, 3]))

  await assert.rejects(
    readLocalPcmTempFileIntoBuffer(sink, Buffer.alloc(8), 8, { chunkBytes: 2 }),
    /ended before its validated byte length/
  )
  await cleanupLocalPcmTempFileSink(sink)
})

test('checks cancellation between bounded reads', async (t) => {
  const root = await makeTestRoot(t)
  const sink = await createLocalPcmTempFileSink(root)
  await writeFile(sink.outputPath, Buffer.alloc(12, 4))
  let checks = 0

  await assert.rejects(
    readLocalPcmTempFileIntoBuffer(sink, Buffer.alloc(12), 12, {
      chunkBytes: 4,
      isCancelled: () => {
        checks += 1
        return checks > 1
      }
    }),
    /read was cancelled/
  )
  assert.equal(checks, 2)
  await cleanupLocalPcmTempFileSink(sink)
})
