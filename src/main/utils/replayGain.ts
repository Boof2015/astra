import type { IAudioMetadata } from 'music-metadata'

export interface ReplayGainValues {
  trackGainDb: number | null
  albumGainDb: number | null
}

type ReplayGainMetadata = Pick<IAudioMetadata, 'common' | 'format' | 'native'>

interface NativeReplayGainValues extends ReplayGainValues {
  r128TrackGainDb: number | null
  r128AlbumGainDb: number | null
}

const R128_GAIN_SCALE = 256
const R128_GAIN_MIN = -32_768
const R128_GAIN_MAX = 32_767
const R128_GAIN_PATTERN = /^[+-]?\d+$/

function normalizeReplayGainTagId(id: string): string {
  return id.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function isTrackReplayGainTagId(id: string): boolean {
  const normalized = normalizeReplayGainTagId(id)
  return normalized.includes('replaygain_track_gain') || normalized.includes('rg_track_gain')
}

function isAlbumReplayGainTagId(id: string): boolean {
  const normalized = normalizeReplayGainTagId(id)
  return normalized.includes('replaygain_album_gain') || normalized.includes('rg_album_gain')
}

function isTrackR128GainTagId(id: string): boolean {
  return normalizeReplayGainTagId(id) === 'r128_track_gain'
}

function isAlbumR128GainTagId(id: string): boolean {
  return normalizeReplayGainTagId(id) === 'r128_album_gain'
}

function isOpusMetadata(metadata: ReplayGainMetadata): boolean {
  return typeof metadata.format.codec === 'string'
    && metadata.format.codec.trim().toLowerCase().includes('opus')
}

export function normalizeReplayGainDb(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = normalizeReplayGainDb(entry)
      if (parsed != null) return parsed
    }
    return null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null

    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) return parsed

    const withDbSuffix = trimmed.replace(/\s*dB\s*$/i, '').trim()
    const parsedWithDbSuffix = Number(withDbSuffix)
    if (Number.isFinite(parsedWithDbSuffix)) return parsedWithDbSuffix

    const match = trimmed.match(/[+-]?\d+(?:[.,]\d+)?/)
    if (!match) return null
    const parsedFromMatch = Number(match[0].replace(',', '.'))
    return Number.isFinite(parsedFromMatch) ? parsedFromMatch : null
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const objectCandidates: unknown[] = [
      record.dB,
      record.db,
      record.gain,
      record.value,
      record.text
    ]
    for (const candidate of objectCandidates) {
      const parsed = normalizeReplayGainDb(candidate)
      if (parsed != null) return parsed
    }
  }
  return null
}

export function normalizeR128GainDb(value: unknown): number | null {
  let gainQ78: number

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return null
    gainQ78 = value
  } else if (typeof value === 'string') {
    if (
      value.length === 0
      || value.length > 6
      || !R128_GAIN_PATTERN.test(value)
    ) {
      return null
    }
    gainQ78 = Number(value)
  } else {
    return null
  }

  if (
    !Number.isSafeInteger(gainQ78)
    || gainQ78 < R128_GAIN_MIN
    || gainQ78 > R128_GAIN_MAX
  ) {
    return null
  }

  return gainQ78 / R128_GAIN_SCALE
}

function extractReplayGainFromCommon(metadata: ReplayGainMetadata): ReplayGainValues {
  const common = metadata.common as unknown as Record<string, unknown>
  let trackGainDb = normalizeReplayGainDb(common.replaygain_track_gain)
  let albumGainDb = normalizeReplayGainDb(common.replaygain_album_gain)

  for (const [key, rawValue] of Object.entries(common)) {
    if (trackGainDb == null && isTrackReplayGainTagId(key)) {
      trackGainDb = normalizeReplayGainDb(rawValue)
    }
    if (albumGainDb == null && isAlbumReplayGainTagId(key)) {
      albumGainDb = normalizeReplayGainDb(rawValue)
    }
    if (trackGainDb != null && albumGainDb != null) {
      break
    }
  }

  return {
    trackGainDb,
    albumGainDb
  }
}

function extractReplayGainFromNative(
  metadata: ReplayGainMetadata,
  includeR128: boolean
): NativeReplayGainValues {
  let trackGainDb: number | null = null
  let albumGainDb: number | null = null
  let r128TrackGainDb: number | null = null
  let r128AlbumGainDb: number | null = null
  const nativeCollections = Object.values(metadata.native ?? {})

  for (const tags of nativeCollections) {
    if (!Array.isArray(tags)) continue
    for (const rawTag of tags) {
      if (!rawTag || typeof rawTag !== 'object') continue
      const tag = rawTag as { id?: unknown; value?: unknown }
      const id = typeof tag.id === 'string' ? tag.id : ''
      if (!id) continue

      if (trackGainDb == null && isTrackReplayGainTagId(id)) {
        trackGainDb = normalizeReplayGainDb(tag.value)
      }
      if (albumGainDb == null && isAlbumReplayGainTagId(id)) {
        albumGainDb = normalizeReplayGainDb(tag.value)
      }
      if (includeR128 && r128TrackGainDb == null && isTrackR128GainTagId(id)) {
        r128TrackGainDb = normalizeR128GainDb(tag.value)
      }
      if (includeR128 && r128AlbumGainDb == null && isAlbumR128GainTagId(id)) {
        r128AlbumGainDb = normalizeR128GainDb(tag.value)
      }

      if (
        trackGainDb != null
        && albumGainDb != null
        && (!includeR128 || (r128TrackGainDb != null && r128AlbumGainDb != null))
      ) {
        return {
          trackGainDb,
          albumGainDb,
          r128TrackGainDb,
          r128AlbumGainDb
        }
      }
    }
  }

  return {
    trackGainDb,
    albumGainDb,
    r128TrackGainDb,
    r128AlbumGainDb
  }
}

export function extractReplayGainDb(metadata: ReplayGainMetadata): ReplayGainValues {
  const commonReplayGain = extractReplayGainFromCommon(metadata)
  const nativeReplayGain = extractReplayGainFromNative(metadata, isOpusMetadata(metadata))
  const trackGainDb = commonReplayGain.trackGainDb
    ?? normalizeReplayGainDb(metadata.format.trackGain)
    ?? nativeReplayGain.trackGainDb
    ?? nativeReplayGain.r128TrackGainDb
  const albumGainDb = commonReplayGain.albumGainDb
    ?? normalizeReplayGainDb(metadata.format.albumGain)
    ?? nativeReplayGain.albumGainDb
    ?? nativeReplayGain.r128AlbumGainDb

  return {
    trackGainDb,
    albumGainDb
  }
}
