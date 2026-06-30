const DISCORD_SHORT_TITLE_PADDING = '\u200B'
const DISCORD_TRUNCATION_SUFFIX = '\u2026'
const DISCORD_ACTIVITY_NAME = 'Astra'
const DISCORD_LISTENING_ACTIVITY_TYPE = 2
const DISCORD_STATUS_DISPLAY_STATE = 1
const DISCORD_STATUS_DISPLAY_DETAILS = 2

export type DiscordActivityPlaybackState = 'stopped' | 'playing' | 'paused' | 'loading'
export type DiscordActivityCompactStatusMode = 'title' | 'artist'
export type DiscordActivityExpandedInfoMode = 'file-info' | 'album'
export type DiscordActivityLinkDestination = 'off' | 'ytmusic' | 'lastfm'

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
  smallImageKey?: string
  smallImageText?: string
  smallImageLinkUrl?: string
  linkDestination?: DiscordActivityLinkDestination
  nowSeconds?: number
  compactStatusMode?: DiscordActivityCompactStatusMode
  expandedInfoMode?: DiscordActivityExpandedInfoMode
}

export interface DiscordRichPresenceActivity {
  [key: string]: unknown
  name: string
  type: number
  details: string
  details_url?: string
  state?: string
  state_url?: string
  status_display_type: number
  instance: false
  timestamps?: {
    start: number
    end?: number
  }
  assets?: {
    large_image: string
    large_text?: string
    large_url?: string
    small_image?: string
    small_text?: string
    small_url?: string
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

// Discord rejects activity URLs longer than 256 characters; drop them instead of
// truncating, since a cut percent-encoding breaks the link entirely.
const DISCORD_URL_MAX_LENGTH = 256

function asDiscordUrl(url: string): string | undefined {
  return url.length <= DISCORD_URL_MAX_LENGTH ? url : undefined
}

function buildSearchLinkUrl(base: string, terms: Array<string | undefined>): string | undefined {
  const query = terms.filter((term): term is string => Boolean(term)).join(' ')
  if (!query) return undefined
  return asDiscordUrl(`${base}${encodeURIComponent(query)}`)
}

export function buildTrackLinkUrl(
  destination: DiscordActivityLinkDestination,
  title?: string,
  artist?: string
): string | undefined {
  if (!title) return undefined
  if (destination === 'ytmusic') {
    return buildSearchLinkUrl('https://music.youtube.com/search?q=', [title, artist])
  }
  if (destination === 'lastfm') {
    if (!artist) return undefined
    return asDiscordUrl(`https://www.last.fm/music/${encodeURIComponent(artist)}/_/${encodeURIComponent(title)}`)
  }
  return undefined
}

export function buildArtistLinkUrl(
  destination: DiscordActivityLinkDestination,
  artist?: string
): string | undefined {
  if (!artist) return undefined
  if (destination === 'ytmusic') {
    return buildSearchLinkUrl('https://music.youtube.com/search?q=', [artist])
  }
  if (destination === 'lastfm') {
    return asDiscordUrl(`https://www.last.fm/music/${encodeURIComponent(artist)}`)
  }
  return undefined
}

export function buildAlbumLinkUrl(
  destination: DiscordActivityLinkDestination,
  album?: string,
  artist?: string
): string | undefined {
  if (!album) return undefined
  if (destination === 'ytmusic') {
    return buildSearchLinkUrl('https://music.youtube.com/search?q=', [album, artist])
  }
  if (destination === 'lastfm') {
    if (!artist) return undefined
    return asDiscordUrl(`https://www.last.fm/music/${encodeURIComponent(artist)}/${encodeURIComponent(album)}`)
  }
  return undefined
}

function buildExpandedInfoLine(
  track: DiscordActivityTrackPresence,
  mode: DiscordActivityExpandedInfoMode
): string | null {
  if (mode === 'album') {
    return normalizeText(track.album) ?? null
  }

  return buildQualityLine(track)
}

export function buildDiscordActivityFromPresence(
  presence: DiscordActivityPresenceUpdate | null,
  options: BuildDiscordActivityOptions = {}
): DiscordRichPresenceActivity | null {
  if (!presence || !presence.track) return null
  if (presence.playbackState === 'stopped') return null

  const details = normalizeDiscordActivityDetails(presence.track.title, 128)
  if (!details) return null

  const compactStatusMode = options.compactStatusMode ?? 'title'
  const expandedInfoMode = options.expandedInfoMode ?? 'file-info'
  const artistLine = normalizeText(presence.track.artist)

  const activity: DiscordRichPresenceActivity = {
    name: DISCORD_ACTIVITY_NAME,
    type: DISCORD_LISTENING_ACTIVITY_TYPE,
    details,
    status_display_type: compactStatusMode === 'artist' && artistLine
      ? DISCORD_STATUS_DISPLAY_STATE
      : DISCORD_STATUS_DISPLAY_DETAILS,
    instance: false
  }

  const state = buildPlaybackStateLine(presence.playbackState, artistLine)
  if (state) {
    activity.state = state
  }

  const linkDestination = options.linkDestination ?? 'off'
  if (linkDestination !== 'off') {
    const detailsUrl = buildTrackLinkUrl(linkDestination, normalizeText(presence.track.title), artistLine)
    if (detailsUrl) {
      activity.details_url = detailsUrl
    }
    const stateUrl = buildArtistLinkUrl(linkDestination, artistLine)
    if (activity.state && stateUrl) {
      activity.state_url = stateUrl
    }
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
    const expandedInfoLine = buildExpandedInfoLine(presence.track, expandedInfoMode)
    activity.assets = {
      large_image: options.largeImageUrl
    }
    if (expandedInfoLine) {
      activity.assets.large_text = truncateDiscordField(expandedInfoLine, 128)
    }
    if (linkDestination !== 'off') {
      // Album pages are keyed by album artist when available; fall back to the track artist.
      const albumArtistLine = normalizeText(presence.track.albumArtist) ?? artistLine
      const largeUrl = buildAlbumLinkUrl(linkDestination, normalizeText(presence.track.album), albumArtistLine)
      if (largeUrl) {
        activity.assets.large_url = largeUrl
      }
    }
    const smallImageKey = normalizeText(options.smallImageKey)
    if (smallImageKey) {
      activity.assets.small_image = smallImageKey
      const smallImageText = normalizeText(options.smallImageText)
      if (smallImageText) {
        activity.assets.small_text = truncateDiscordField(smallImageText, 128)
      }
      const smallImageLinkUrl = asDiscordUrl(normalizeText(options.smallImageLinkUrl) ?? '')
      if (smallImageLinkUrl) {
        activity.assets.small_url = smallImageLinkUrl
      }
    }
  }

  return activity
}
