import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

export const DEFAULT_LOCAL_PCM_PROBE_CACHE_MAX_ENTRIES = 128

export interface LocalPcmProbeResult {
  readonly channels: number
  readonly durationSeconds: number | null
}

/**
 * A file identity suitable for reusing decoded-stream metadata. BigInt stats
 * avoid losing nanosecond timestamps or large inode/file-size values to
 * Number precision.
 */
export interface LocalPcmProbeFileIdentity {
  readonly canonicalPath: string
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs?: bigint
  readonly birthtimeNs?: bigint
}

export type LocalPcmProbeCacheStatus = 'hit' | 'miss' | 'bypass'

export interface LocalPcmProbeCacheResolution {
  readonly result: LocalPcmProbeResult
  /**
   * `miss` means the successful result was committed to the cache. `bypass`
   * means probing succeeded but the cache could not safely use or retain it.
   */
  readonly cacheStatus: LocalPcmProbeCacheStatus
}

export interface LocalPcmProbeCacheOptions {
  readonly maxEntries?: number
  readonly identifyFile?: (filePath: string) => Promise<LocalPcmProbeFileIdentity | null>
}

interface LocalPcmProbeCacheEntry {
  readonly identity: LocalPcmProbeFileIdentity
  readonly result: LocalPcmProbeResult
}

function optionalBigInt(value: unknown): bigint | undefined {
  return typeof value === 'bigint' ? value : undefined
}

/**
 * Resolves symlinks before collecting a BigInt stat fingerprint. Any path or
 * stat failure deliberately returns null so probing can proceed uncached.
 */
export async function identifyLocalPcmProbeFile(
  filePath: string
): Promise<LocalPcmProbeFileIdentity | null> {
  try {
    const canonicalPath = await realpath(resolve(filePath))
    const fileStats = await stat(canonicalPath, { bigint: true })
    const ctimeNs = optionalBigInt(fileStats.ctimeNs)
    const birthtimeNs = optionalBigInt(fileStats.birthtimeNs)

    return {
      canonicalPath,
      dev: fileStats.dev,
      ino: fileStats.ino,
      size: fileStats.size,
      mtimeNs: fileStats.mtimeNs,
      ...(ctimeNs === undefined ? {} : { ctimeNs }),
      ...(birthtimeNs === undefined ? {} : { birthtimeNs })
    }
  } catch {
    return null
  }
}

export function isValidLocalPcmProbeResult(
  result: LocalPcmProbeResult
): boolean {
  return Number.isInteger(result.channels)
    && result.channels >= 1
    && result.channels <= 8
    && (
      result.durationSeconds === null
      || (
        Number.isFinite(result.durationSeconds)
        && result.durationSeconds > 0
      )
    )
}

export function areLocalPcmProbeFileIdentitiesEqual(
  left: LocalPcmProbeFileIdentity,
  right: LocalPcmProbeFileIdentity
): boolean {
  return left.canonicalPath === right.canonicalPath
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs
}

/**
 * A bounded, process-local cache for successful FFprobe stream results.
 *
 * It intentionally does not coalesce concurrent probes: each playback request
 * retains its own abort/cancellation lifetime. A result is cached only when
 * the same strong file identity is observed before and after the probe.
 */
export class LocalPcmProbeCache {
  private readonly maxEntries: number
  private readonly identifyFile: (
    filePath: string
  ) => Promise<LocalPcmProbeFileIdentity | null>
  private readonly entries = new Map<string, LocalPcmProbeCacheEntry>()

  constructor(options: LocalPcmProbeCacheOptions = {}) {
    const maxEntries = options.maxEntries
      ?? DEFAULT_LOCAL_PCM_PROBE_CACHE_MAX_ENTRIES
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('Local PCM probe cache maxEntries must be a positive integer.')
    }

    this.maxEntries = maxEntries
    this.identifyFile = options.identifyFile ?? identifyLocalPcmProbeFile
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }

  async getOrProbe(
    filePath: string,
    runProbe: () => Promise<LocalPcmProbeResult>
  ): Promise<LocalPcmProbeCacheResolution> {
    const identityBeforeProbe = await this.identifyFile(filePath)
    if (identityBeforeProbe) {
      const cached = this.entries.get(identityBeforeProbe.canonicalPath)
      if (
        cached
        && areLocalPcmProbeFileIdentitiesEqual(cached.identity, identityBeforeProbe)
      ) {
        // Map insertion order doubles as LRU order; promote a successful hit.
        this.entries.delete(identityBeforeProbe.canonicalPath)
        this.entries.set(identityBeforeProbe.canonicalPath, cached)
        return { result: cached.result, cacheStatus: 'hit' }
      }

      // Do not retain an obsolete fingerprint for the same canonical path.
      if (cached) this.entries.delete(identityBeforeProbe.canonicalPath)
    }

    const probedResult = await runProbe()
    if (!identityBeforeProbe || !isValidLocalPcmProbeResult(probedResult)) {
      return { result: probedResult, cacheStatus: 'bypass' }
    }

    const identityAfterProbe = await this.identifyFile(filePath)
    if (
      !identityAfterProbe
      || !areLocalPcmProbeFileIdentitiesEqual(identityBeforeProbe, identityAfterProbe)
    ) {
      return { result: probedResult, cacheStatus: 'bypass' }
    }

    const cachedResult = Object.freeze({
      channels: probedResult.channels,
      durationSeconds: probedResult.durationSeconds
    })
    this.entries.set(identityAfterProbe.canonicalPath, {
      identity: identityAfterProbe,
      result: cachedResult
    })
    this.evictLeastRecentlyUsedEntries()

    return { result: cachedResult, cacheStatus: 'miss' }
  }

  private evictLeastRecentlyUsedEntries(): void {
    while (this.entries.size > this.maxEntries) {
      const leastRecentlyUsedKey = this.entries.keys().next().value
      if (typeof leastRecentlyUsedKey !== 'string') return
      this.entries.delete(leastRecentlyUsedKey)
    }
  }
}
