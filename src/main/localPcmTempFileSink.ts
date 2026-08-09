import { mkdtemp, open, rm, stat } from 'fs/promises'
import { join } from 'path'

export const LOCAL_PCM_TEMP_FILE_READ_CHUNK_BYTES = 8 * 1024 * 1024

export interface LocalPcmTempFileSink {
  directoryPath: string
  outputPath: string
}

export interface LocalPcmTempFileReadResult {
  byteLength: number
  chunkCount: number
}

export interface LocalPcmTempFileCleanupResult {
  succeeded: boolean
  error: Error | null
}

export interface LocalPcmTempFileReadOptions {
  chunkBytes?: number
  isCancelled?: () => boolean
}

const cleanupBySink = new WeakMap<LocalPcmTempFileSink, Promise<LocalPcmTempFileCleanupResult>>()

function requirePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`)
  }
}

/** Builds only the output tail so the unchanged decoder arguments stay shared. */
export function buildLocalPcmFfmpegOutputArgs(
  sink: LocalPcmTempFileSink | null,
  maxBytes: number
): string[] {
  if (!sink) return ['pipe:1']
  requirePositiveSafeInteger(maxBytes, 'Local PCM temporary sink byte cap')
  if (!Number.isSafeInteger(maxBytes + 1)) {
    throw new RangeError('Local PCM temporary sink FFmpeg limit exceeded the safe integer range.')
  }
  // One extra byte distinguishes a legitimate exact-cap result from the next
  // complete float frame. FFmpeg may overshoot by one packet, so post-close
  // stat validation remains authoritative.
  return ['-fs', String(maxBytes + 1), sink.outputPath]
}

/** Creates one request-owned directory so FFmpeg never shares or overwrites an output path. */
export async function createLocalPcmTempFileSink(
  tempRootPath: string
): Promise<LocalPcmTempFileSink> {
  if (typeof tempRootPath !== 'string' || tempRootPath.length === 0) {
    throw new TypeError('Local PCM temporary sink requires a temporary root path.')
  }
  const directoryPath = await mkdtemp(join(tempRootPath, 'astra-local-pcm-'))
  return {
    directoryPath,
    outputPath: join(directoryPath, 'decoded.f32le')
  }
}

/**
 * Inspects the completed FFmpeg output before any potentially large read or
 * allocation. FFmpeg must already be closed, so the size is authoritative.
 */
export async function statBoundedLocalPcmTempFile(
  sink: LocalPcmTempFileSink,
  maxBytes: number
): Promise<number> {
  requirePositiveSafeInteger(maxBytes, 'Local PCM temporary sink byte cap')
  const outputStat = await stat(sink.outputPath)
  if (!outputStat.isFile()) {
    throw new Error('Local PCM temporary sink did not produce a regular file.')
  }
  if (!Number.isSafeInteger(outputStat.size) || outputStat.size <= 0) {
    throw new Error('Local PCM temporary sink produced no decoded audio.')
  }
  if (outputStat.size > maxBytes) {
    throw new Error('Decoded audio exceeds the 192 MiB Standard playback limit.')
  }
  return outputStat.size
}

/**
 * Reads a closed, size-validated PCM file directly into the authoritative
 * preallocated buffer. `byteLength` is committed by the caller only after this
 * function succeeds, so cancellation or a short read cannot expose a prefix.
 */
export async function readLocalPcmTempFileIntoBuffer(
  sink: LocalPcmTempFileSink,
  destination: Buffer,
  byteLength: number,
  options: LocalPcmTempFileReadOptions = {}
): Promise<LocalPcmTempFileReadResult> {
  requirePositiveSafeInteger(byteLength, 'Local PCM temporary sink read length')
  if (destination.byteLength < byteLength) {
    throw new RangeError('Local PCM temporary sink destination is smaller than its decoded output.')
  }
  const chunkBytes = options.chunkBytes ?? LOCAL_PCM_TEMP_FILE_READ_CHUNK_BYTES
  requirePositiveSafeInteger(chunkBytes, 'Local PCM temporary sink read chunk size')

  const handle = await open(sink.outputPath, 'r')
  let offset = 0
  let chunkCount = 0
  try {
    while (offset < byteLength) {
      if (options.isCancelled?.()) {
        throw new Error('Local PCM temporary sink read was cancelled.')
      }
      const requestedBytes = Math.min(chunkBytes, byteLength - offset)
      const { bytesRead } = await handle.read(
        destination,
        offset,
        requestedBytes,
        offset
      )
      if (bytesRead <= 0) {
        throw new Error('Local PCM temporary sink ended before its validated byte length.')
      }
      offset += bytesRead
      chunkCount += 1
    }

    // FFmpeg is already closed, so a trailing byte means the prior stat no
    // longer describes the file and the result must not be committed.
    const trailingByte = Buffer.allocUnsafe(1)
    const { bytesRead: trailingBytesRead } = await handle.read(
      trailingByte,
      0,
      1,
      byteLength
    )
    if (trailingBytesRead !== 0) {
      throw new Error('Local PCM temporary sink grew after its size validation.')
    }
    return { byteLength: offset, chunkCount }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Best-effort and idempotent; a cleanup failure must not invalidate decoded PCM. */
export function cleanupLocalPcmTempFileSink(
  sink: LocalPcmTempFileSink
): Promise<LocalPcmTempFileCleanupResult> {
  const existing = cleanupBySink.get(sink)
  if (existing) return existing

  const cleanup = rm(sink.directoryPath, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50
  }).then<LocalPcmTempFileCleanupResult, LocalPcmTempFileCleanupResult>(
    () => ({ succeeded: true, error: null }),
    (error: unknown) => ({
      succeeded: false,
      error: error instanceof Error ? error : new Error(String(error))
    })
  )
  cleanupBySink.set(sink, cleanup)
  return cleanup
}
