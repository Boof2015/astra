import type { PcmTransferBenchmarkProbeResult } from '../types/diagnostics'
import {
  LOCAL_PCM_STREAM_CHUNK_BYTES,
  LOCAL_PCM_STREAM_VERSION
} from './localPcmStream'

export const PCM_TRANSFER_BENCHMARK_MAX_BYTES = 72 * 1024 * 1024

export const PCM_TRANSFER_BENCHMARK_STREAM_IPC_CHANNEL = 'diagnostics:benchmarkMainPcmTransferStream' as const
export const PCM_TRANSFER_BENCHMARK_STREAM_VERSION = LOCAL_PCM_STREAM_VERSION

export const PCM_TRANSFER_BENCHMARK_SENTINELS = Object.freeze({
  first: 0xa5,
  middle: 0x5a,
  last: 0xc3
})

type BenchmarkClock = () => number

export interface PcmTransferBenchmarkStreamOpenRequest {
  version: typeof PCM_TRANSFER_BENCHMARK_STREAM_VERSION
  requestId: number
  sizeBytes: number
  nonce: string
}

function defaultBenchmarkClock(): number {
  return performance.now()
}

function roundBenchmarkMs(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100
}

export function normalizePcmTransferBenchmarkSize(sizeValue: unknown): number {
  const sizeBytes = Number(sizeValue)
  if (
    !Number.isSafeInteger(sizeBytes)
    || sizeBytes <= 0
    || sizeBytes > PCM_TRANSFER_BENCHMARK_MAX_BYTES
  ) {
    throw new RangeError('PCM transfer benchmark size must be an integer between 1 byte and 72 MiB.')
  }
  return sizeBytes
}

export function validatePcmTransferBenchmarkStreamOpenRequest(
  value: unknown
): value is PcmTransferBenchmarkStreamOpenRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const request = value as Record<string, unknown>
  return request.version === PCM_TRANSFER_BENCHMARK_STREAM_VERSION
    && typeof request.requestId === 'number'
    && Number.isSafeInteger(request.requestId)
    && request.requestId >= 0
    && typeof request.sizeBytes === 'number'
    && Number.isSafeInteger(request.sizeBytes)
    && request.sizeBytes > 0
    && request.sizeBytes <= PCM_TRANSFER_BENCHMARK_MAX_BYTES
    && request.sizeBytes % Float32Array.BYTES_PER_ELEMENT === 0
    && typeof request.nonce === 'string'
    && request.nonce.length > 0
    && request.nonce.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(request.nonce)
}

/**
 * Fills one bounded benchmark chunk as if it were a slice of the legacy full
 * payload. Callers can release every chunk after posting instead of retaining
 * a payload as large as the requested benchmark size.
 */
export function fillPcmTransferBenchmarkChunk(
  bytes: Uint8Array,
  byteOffset: number,
  totalSizeBytes: number
): void {
  if (
    !Number.isSafeInteger(byteOffset)
    || byteOffset < 0
    || !Number.isSafeInteger(totalSizeBytes)
    || totalSizeBytes <= 0
    || totalSizeBytes > PCM_TRANSFER_BENCHMARK_MAX_BYTES
    || bytes.byteLength <= 0
    || bytes.byteLength > LOCAL_PCM_STREAM_CHUNK_BYTES
    || byteOffset + bytes.byteLength > totalSizeBytes
  ) {
    throw new RangeError('PCM transfer benchmark chunk is outside the bounded payload.')
  }

  bytes.fill(0x6d)
  const sentinelByOffset: ReadonlyArray<readonly [number, number]> = [
    [0, PCM_TRANSFER_BENCHMARK_SENTINELS.first],
    [Math.floor(totalSizeBytes / 2), PCM_TRANSFER_BENCHMARK_SENTINELS.middle],
    [totalSizeBytes - 1, PCM_TRANSFER_BENCHMARK_SENTINELS.last]
  ]
  const byteEnd = byteOffset + bytes.byteLength
  for (const [sentinelOffset, sentinel] of sentinelByOffset) {
    if (sentinelOffset >= byteOffset && sentinelOffset < byteEnd) {
      bytes[sentinelOffset - byteOffset] = sentinel
    }
  }
}

export function createPcmTransferBenchmarkProbe(
  sizeValue: unknown,
  clock: BenchmarkClock = defaultBenchmarkClock
): PcmTransferBenchmarkProbeResult {
  const sizeBytes = normalizePcmTransferBenchmarkSize(sizeValue)

  const allocationStartedAtMs = clock()
  const payload = new ArrayBuffer(sizeBytes)
  const allocationMs = roundBenchmarkMs(clock() - allocationStartedAtMs)

  const fillStartedAtMs = clock()
  const bytes = new Uint8Array(payload)
  bytes.fill(0x6d)
  bytes[0] = PCM_TRANSFER_BENCHMARK_SENTINELS.first
  bytes[Math.floor(sizeBytes / 2)] = PCM_TRANSFER_BENCHMARK_SENTINELS.middle
  bytes[sizeBytes - 1] = PCM_TRANSFER_BENCHMARK_SENTINELS.last
  const fillMs = roundBenchmarkMs(clock() - fillStartedAtMs)

  return {
    sizeBytes,
    byteLength: payload.byteLength,
    payload,
    allocationMs,
    fillMs
  }
}

export function validatePcmTransferBenchmarkProbe(
  probe: PcmTransferBenchmarkProbeResult,
  expectedSizeBytes: number = probe.sizeBytes
): boolean {
  if (
    !Number.isSafeInteger(expectedSizeBytes)
    || probe.sizeBytes !== expectedSizeBytes
    || probe.byteLength !== expectedSizeBytes
    || !(probe.payload instanceof ArrayBuffer)
    || probe.payload.byteLength !== expectedSizeBytes
  ) {
    return false
  }

  const bytes = new Uint8Array(probe.payload)
  const expectedByOffset = new Map<number, number>([
    [0, PCM_TRANSFER_BENCHMARK_SENTINELS.first],
    [Math.floor(expectedSizeBytes / 2), PCM_TRANSFER_BENCHMARK_SENTINELS.middle],
    [expectedSizeBytes - 1, PCM_TRANSFER_BENCHMARK_SENTINELS.last]
  ])
  for (const [offset, expected] of expectedByOffset) {
    if (bytes[offset] !== expected) return false
  }
  return true
}
