const DISCORD_SHORT_TITLE_PADDING = '\u200B'
const DISCORD_TRUNCATION_SUFFIX = '\u2026'
const DISCORD_ACTIVITY_NAME = 'Astra'
const DISCORD_LISTENING_ACTIVITY_TYPE = 2
const DISCORD_STATUS_DISPLAY_DETAILS = 2

export type DiscordActivityPlaybackState = 'stopped' | 'playing' | 'paused' | 'loading'

export interface DiscordActivityTrackPresence {
  title: string
  artist?: string
  album?: string
  albumArtist?: string
  coverArtUrl?: string
  durationSeconds?: number
  format?: string
  sampleRate?: number
  bitDepth?: number
  bitrate?: number
  channels?: number
  codec?: string
  codecProfile?: string
  isAtmosJoc?: boolean
}

export interface DiscordActivityPresenceUpdate {
  playbackState: DiscordActivityPlaybackState
  currentTimeSeconds?: number
  durationSeconds?: number
  track?: DiscordActivityTrackPresence | null
}

export interface BuildDiscordActivityOptions {
  largeImageUrl?: string
  nowSeconds?: number
}

export interface DiscordRichPresenceActivity {
  [key: string]: unknown
  name: string
  type: number
  details: string
  state?: string
  status_display_type: number
  instance: false
  timestamps?: {
    start: number
    end?: number
  }
  assets?: {
    large_image: string
    large_text?: string
  }
}

export function truncateDiscordField(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return value.slice(0, maxLength - 1) + DISCORD_TRUNCATION_SUFFIX
}

export function normalizeDiscordActivityDetails(title: string, maxLength: number): string | null {
  const normalized = title.trim()
  if (!normalized) return null

  const padded = normalized.length === 1
    ? `${normalized}${DISCORD_SHORT_TITLE_PADDING}`
    : normalized

  return truncateDiscordField(padded, maxLength)
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined
  if (!Number.isFinite(value)) return undefined
  if (value < 0) return 0
  return value
}

function formatSampleRate(sampleRate?: number): string | null {
  const normalized = normalizeNumber(sampleRate)
  if (!normalized || normalized <= 0) return null
  if (normalized >= 1000) {
    const khz = Math.round((normalized / 1000) * 10) / 10
    return Number.isInteger(khz) ? `${khz.toFixed(0)}kHz` : `${khz.toFixed(1)}kHz`
  }
  return `${Math.round(normalized)}Hz`
}

function formatAudioLabel(value?: string): string | null {
  const normalized = normalizeText(value)
  if (!normalized) return null
  return /^[a-z0-9._+-]+$/i.test(normalized) ? normalized.toUpperCase() : normalized
}

function buildQualityLine(track: DiscordActivityTrackPresence): string | null {
  const parts: string[] = []

  if (track.isAtmosJoc) {
    parts.push('Atmos JOC')
  } else {
    const codecLine = formatAudioLabel(track.codec) ?? formatAudioLabel(track.format)
    if (codecLine) {
      parts.push(codecLine)
    }
  }

  const bitDepth = normalizeNumber(track.bitDepth)
  if (bitDepth && bitDepth > 0) {
    parts.push(`${Math.round(bitDepth)}-bit`)
  }

  const sampleRate = formatSampleRate(track.sampleRate)
  if (sampleRate) parts.push(sampleRate)

  if (parts.length === 0) return null
  return parts.join(' • ')
}

function buildPlaybackStateLine(
  playbackState: DiscordActivityPlaybackState,
  artist?: string
): string | undefined {
  const artistLine = normalizeText(artist)

  if (playbackState === 'playing') {
    return artistLine ? truncateDiscordField(artistLine, 128) : undefined
  }

  if (playbackState === 'paused') {
    return truncateDiscordField(artistLine ? `Paused • ${artistLine}` : 'Paused', 128)
  }

  if (playbackState === 'loading') {
    return truncateDiscordField(artistLine ? `Loading • ${artistLine}` : 'Loading', 128)
  }

  return undefined
}

export function buildDiscordActivityFromPresence(
  presence: DiscordActivityPresenceUpdate | null,
  options: BuildDiscordActivityOptions = {}
): DiscordRichPresenceActivity | null {
  if (!presence || !presence.track) return null
  if (presence.playbackState === 'stopped') return null

  const details = normalizeDiscordActivityDetails(presence.track.title, 128)
  if (!details) return null

  const activity: DiscordRichPresenceActivity = {
    name: DISCORD_ACTIVITY_NAME,
    type: DISCORD_LISTENING_ACTIVITY_TYPE,
    details,
    status_display_type: DISCORD_STATUS_DISPLAY_DETAILS,
    instance: false
  }

  const state = buildPlaybackStateLine(presence.playbackState, presence.track.artist)
  if (state) {
    activity.state = state
  }

  if (presence.playbackState === 'playing') {
    const duration = normalizeNumber(presence.durationSeconds ?? presence.track.durationSeconds)
    const current = normalizeNumber(presence.currentTimeSeconds) ?? 0
    const now = Math.floor(options.nowSeconds ?? Date.now() / 1000)
    const start = Math.max(0, now - Math.floor(current))
    if (duration && duration > 0) {
      activity.timestamps = {
        start,
        end: start + Math.floor(duration)
      }
    } else {
      activity.timestamps = { start }
    }
  }

  if (options.largeImageUrl) {
    const qualityLine = buildQualityLine(presence.track)
    activity.assets = {
      large_image: options.largeImageUrl
    }
    if (qualityLine) {
      activity.assets.large_text = truncateDiscordField(qualityLine, 128)
    }
  }

  return activity
}
