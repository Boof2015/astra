import { useEffect, useMemo, useRef, useState } from 'react'
import { useLibraryStore, type LibraryArtistBrowseMode } from '../../stores/libraryStore'
import { usePlayerStore } from '../../stores/playerStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useUIStore } from '../../stores/uiStore'
import type { TrackSourceType } from '../../../types/subsonic'
import { useHorizontalWheelScroll } from '../../hooks/useHorizontalWheelScroll'
import { buildAlbumIdentityKeyFromTrack, buildAlbumKey, getAlbumIdentityArtist, normalizeKey, splitCollaborators } from '../../utils/albumIdentity'
import { formatExactDuration } from '../../utils/collectionDuration'
import { formatPlaylistImportStatus, type PlaylistImportStatus } from '../../utils/playlistImportStatus'
import { buildPlaylistDisplaySections } from '../../utils/playlistSystem'
import AlbumArtwork from '../library/AlbumArtwork'
import CreatePlaylistModal from '../playlists/CreatePlaylistModal'
import PlaylistCover from '../playlists/PlaylistCover'
import type { DynamicPlaylistRulesV1 } from '../../../shared/playlists/dynamicPlaylist'

interface HomeTrack {
  path: string
  album_identity_key: string
  title: string
  artist: string
  artist_names: string[]
  album: string
  album_artist: string | null
  album_artist_names: string[]
  duration: number
  format: string
  artwork_hash: string | null
  base_artwork_hash: string | null
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
  channels: number | null
  replaygain_track_gain_db: number | null
  replaygain_album_gain_db: number | null
  source_type: TrackSourceType
  source_id: number | null
  source_track_id: string | null
  source_path: string | null
  is_available: number
  availability_reason: string | null
  codec?: string | null
  codec_profile?: string | null
  is_atmos_joc?: number | null
  is_iamf?: number | null
}

interface HomeAlbum {
  identity_key: string
  album: string
  artist: string
  year: number | null
  artwork_hash: string | null
  track_count: number
}

interface HomeArtist {
  artist: string
  track_count: number
  artwork_hash: string | null
}

type TimeBucket = 'morning' | 'afternoon' | 'evening' | 'late-night'

interface GreetingCopy {
  id: string
  primary: string
  subline: string
}

interface GreetingSelection extends GreetingCopy {
  bucket: TimeBucket
}

interface BucketPalette {
  top: [number, number, number]
  mid: [number, number, number]
  bottom: [number, number, number]
  starOpacity: number
}

interface SkyColorKeyframe {
  hour: number
  top: [number, number, number]
  mid: [number, number, number]
  bottom: [number, number, number]
  stars: number
}

interface PixelStar {
  gx: number
  gy: number
  phase: number
  freq: number
  bright: number
  cross: boolean
}

interface PixelCluster {
  gx: number
  gy: number
}

interface StarField {
  stars: PixelStar[]
  clusters: PixelCluster[]
}

interface TimeGreetingWindow {
  startMinute: number
  endMinute: number
  messages: GreetingCopy[]
}

interface WeightedGreetingPool {
  messages: GreetingCopy[]
  weight: number
}

interface HomeRecentLimits {
  track: number
  artist: number
  album: number
}

const HOME_RECENT_MEDIUM_BREAKPOINT_PX = 1200
const HOME_RECENT_LARGE_BREAKPOINT_PX = 1440
const HOME_RECENT_LIMITS_SMALL: HomeRecentLimits = { track: 8, artist: 6, album: 6 }
const HOME_RECENT_LIMITS_MEDIUM: HomeRecentLimits = { track: 10, artist: 8, album: 8 }
const HOME_RECENT_LIMITS_LARGE: HomeRecentLimits = { track: 12, artist: 10, album: 10 }
const GREETING_ROTATION_MS = 30 * 60 * 1000
const SKY_PIXEL_SCALE = 4
const STAR_GRID_SIZE = 6
const STAR_PIXEL_SIZE = 2
const STAR_CLUSTER_RATIO = 0.16
const STAR_OPACITY_SCALE = 0.52
const GREETING_WEIGHT_TIME_AWARE = 0.4
const GREETING_WEIGHT_DAY_AWARE = 0.28
const GREETING_WEIGHT_PLAYFUL = 0.32
const GENERIC_ARTIST_KEYS = new Set(['various artists', 'various artist', 'va', 'v a'])

const SKY_COLOR_KEYFRAMES: SkyColorKeyframe[] = [
  { hour: 0, top: [10, 13, 28], mid: [7, 8, 15], bottom: [4, 4, 10], stars: 1.0 },
  { hour: 4, top: [12, 16, 36], mid: [8, 10, 16], bottom: [4, 4, 10], stars: 0.9 },
  { hour: 4.6, top: [18, 16, 52], mid: [11, 10, 20], bottom: [5, 4, 10], stars: 0.78 },
  { hour: 5, top: [30, 18, 64], mid: [16, 12, 28], bottom: [6, 5, 12], stars: 0.65 },
  { hour: 5.35, top: [58, 24, 68], mid: [22, 13, 30], bottom: [6, 5, 12], stars: 0.5 },
  { hour: 5.8, top: [90, 32, 64], mid: [30, 14, 24], bottom: [7, 5, 12], stars: 0.25 },
  { hour: 6.15, top: [116, 52, 64], mid: [35, 18, 20], bottom: [7, 5, 11], stars: 0.14 },
  { hour: 6.5, top: [138, 72, 64], mid: [42, 20, 16], bottom: [8, 6, 10], stars: 0.05 },
  { hour: 6.9, top: [142, 104, 88], mid: [40, 28, 20], bottom: [8, 7, 10], stars: 0.02 },
  { hour: 7.3, top: [130, 136, 152], mid: [34, 44, 54], bottom: [8, 10, 12], stars: 0.0 },
  { hour: 7.8, top: [114, 146, 170], mid: [28, 38, 50], bottom: [7, 10, 12], stars: 0.0 },
  { hour: 9, top: [90, 138, 170], mid: [24, 36, 48], bottom: [7, 10, 12], stars: 0.0 },
  { hour: 12, top: [74, 120, 152], mid: [20, 32, 48], bottom: [6, 9, 12], stars: 0.0 },
  { hour: 15, top: [80, 112, 144], mid: [22, 30, 42], bottom: [6, 8, 9], stars: 0.0 },
  { hour: 17, top: [144, 96, 80], mid: [40, 26, 20], bottom: [8, 6, 10], stars: 0.0 },
  { hour: 18, top: [144, 64, 64], mid: [42, 16, 16], bottom: [9, 5, 10], stars: 0.05 },
  { hour: 19, top: [96, 32, 80], mid: [26, 12, 24], bottom: [7, 5, 12], stars: 0.2 },
  { hour: 20, top: [36, 24, 56], mid: [14, 12, 28], bottom: [6, 5, 14], stars: 0.5 },
  { hour: 22, top: [16, 20, 40], mid: [9, 10, 20], bottom: [4, 4, 12], stars: 0.85 },
  { hour: 24, top: [10, 13, 28], mid: [7, 8, 15], bottom: [4, 4, 10], stars: 1.0 }
]

const PLAYFUL_GREETINGS: GreetingCopy[] = [
  {
    id: 'playful-back-again',
    primary: 'Back again.',
    subline: 'Your music, my liege.'
  },
  {
    id: 'playful-silence',
    primary: 'Silence?',
    subline: 'Not today.'
  },
  {
    id: 'playful-missed-you',
    primary: 'Missed you!',
    subline: 'Don\'t look behind you'
  },
  {
    id: 'playful-no-algo',
    primary: 'No algorithm.',
    subline: 'Just you.'
  },
  {
    id: 'playful-aux',
    primary: 'The aux is yours.',
    subline: ''
  },
  {
    id: 'playful-video',
    primary: 'Now a video player!',
    subline: 'Just kidding'
  },
  {
    id: 'playful-japanese',
    primary: '何か日本語で',
    subline: 'It\'s something in Japanese'
  },
  {
    id: 'playful-quote',
    primary: 'To know your enemy is to listen to their bad music',
    subline: '- Sun Tzu, The Art of War ...maybe (idk tho)'
  },
  {
    id: 'playful-test',
    primary: 'test1_funny_dialogue',
    subline: 'i ran out of ideas please laugh'
  },
  {
    id: 'playful-hey',
    primary: 'hey...',
    subline: 'does anyone even read these?'
  },
  {
    id: 'playful-ranked',
    primary: 'New feature:',
    subline: 'Astra ranked'
  },
  {
    id: 'playful-mistake',
    primary: 'Here is the AUX',
    subline: 'DO NOT MESS THIS UP'
  },
  {
    id: 'playful-claude',
    primary: 'Claude Flibbergibbeted this',
    subline: 'If anything\'s broken, blame Claude'
  },
  {
    id: 'playful-cable',
    primary: 'Now featuring interdimensional cable',
    subline: 'This plumbus thing is really cool'
  },
  {
    id: 'playful-train',
    primary: 'I like trains',
    subline: ''
  },
  {
    id: 'playful-chips',
    primary: 'You call these things chips?',
    subline: 'Instead of Crispity Cruncy Munchie Crackerjack Snacker Nibbler Snap Crack N Pop Westpoolchestershireshire Queen\'s Lovely Jubily Delight?'
  },
  {
    id: 'playful-yikes',
    primary: 'hey...',
    subline: 'I just saw your play history... yikes...'
  },
  {
    id: 'playful-combust',
    primary: 'feeling cute',
    subline: 'might spontaniously combust later'
  },
  {
    id: 'playful-hunger',
    primary: 'Feeling hungry...',
    subline: 'Got any spare RAM?'
  },
  {
    id: 'playful-break',
    primary: 'Let me break it down for you...',
    subline: '*breakdances*'
  },
  {
    id: 'playful-sad',
    primary: '"Not everything has to be funny"',
    subline: '- The guy next to me when writing these'
  },
  {
    id: 'playful-silenceno',
    primary: 'Silence?',
    subline: 'nuh uh'
  },
  {
    id: 'playful-helldivers',
    primary: 'All for Super Earth!',
    subline: '...and a good cup of libertea'
  }
]

const TIME_AWARE_GREETINGS: TimeGreetingWindow[] = [
  {
    startMinute: 0,
    endMinute: 180,
    messages: [
      {
        id: 'late-still-up',
        primary: 'Still up?',
        subline: 'Go to sleep.'
      },
      {
        id: 'late-same',
        primary: 'Late night?',
        subline: 'Same.'
      }
    ]
  },
  {
    startMinute: 180,
    endMinute: 300,
    messages: [
      {
        id: 'late-same',
        primary: 'Late night?',
        subline: 'Same.'
      },
      {
        id: 'late-void',
        primary: '3 AM again, huh',
        subline: 'The void has music in it'
      },
      {
        id: 'late-still-up',
        primary: 'Still up?',
        subline: 'Go to sleep.'
      },
      {
        id: 'late-walls',
        primary: '3 AM...',
        subline: 'THEY ARE IN YOUR WALLS'
      },
      {
        id: 'late-british',
        primary: 'You still awake?',
        subline: 'That\'s a bit cringe innit bruv?'
      }
    ]
  },
  {
    startMinute: 300,
    endMinute: 420,
    messages: [
      {
        id: 'morning-easy',
        primary: 'Morning.',
        subline: "It's too early."
      }
    ]
  },
  {
    startMinute: 420,
    endMinute: 660,
    messages: [
      {
        id: 'morning-good',
        primary: 'Good morning!',
        subline: 'Conquer the day'
      },
      {
        id: 'morning-easytwo',
        primary: 'Morning.',
        subline: "Time to break your eardrums."
      }
    ]
  },
  {
    startMinute: 660,
    endMinute: 720,
    messages: [
      {
        id: 'late-morning',
        primary: 'Late morning.',
        subline: 'Have you gotten your coffee yet?'
      }
    ]
  },
  {
    startMinute: 720,
    endMinute: 840,
    messages: [
      {
        id: 'afternoon-halfway',
        primary: 'Good afternoon.',
        subline: 'Halfway there.'
      }
    ]
  },
  {
    startMinute: 840,
    endMinute: 1020,
    messages: [
      {
        id: 'afternoon-stretch',
        primary: 'Afternoon stretch.',
        subline: 'One more push.'
      }
    ]
  },
  {
    startMinute: 1020,
    endMinute: 1080,
    messages: [
      {
        id: 'sunset-switch',
        primary: 'Sunset switch.',
        subline: 'Set the evening tone.'
      }
    ]
  },
  {
    startMinute: 1080,
    endMinute: 1380,
    messages: [
      {
        id: 'evening-night',
        primary: 'Good evening.',
        subline: 'The night is yours.'
      }
    ]
  },
  {
    startMinute: 1380,
    endMinute: 1440,
    messages: [
      {
        id: 'late-same',
        primary: 'Late night?',
        subline: 'Same.'
      },
      {
        id: 'late-still-up',
        primary: 'Still up?',
        subline: 'Astra never sleeps either.'
      }
    ]
  }
]

function artistInitial(artist: string): string {
  return artist.trim().charAt(0).toUpperCase() || '?'
}

function getTimeBucket(date: Date): TimeBucket {
  const hour = date.getHours()
  if (hour >= 5 && hour <= 11) return 'morning'
  if (hour >= 12 && hour <= 17) return 'afternoon'
  if (hour >= 18 && hour <= 22) return 'evening'
  return 'late-night'
}

function getDayAwareGreetings(date: Date): GreetingCopy[] {
  const messages: GreetingCopy[] = []
  const day = date.getDay()
  if (day === 1) {
    messages.push({
      id: 'day-monday',
      primary: 'Monday.',
      subline: "Let's fix that."
    })
  }
  if (day === 3) {
    messages.push({
      id: 'day-wednesday',
      primary: "It's Wednesday somehow.",
      subline: ''
    })
  }
  if (day === 5) {
    messages.push({
      id: 'day-friday',
      primary: "It's Friday.",
      subline: 'You made it.'
    })
  }
  if (day === 0) {
    messages.push({
      id: 'day-sunday',
      primary: 'Sunday already?',
      subline: 'Put something good on.'
    })
  }

  return messages
}

function getMinutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes()
}

function getTimeAwareGreetings(date: Date): GreetingCopy[] {
  const minuteOfDay = getMinutesOfDay(date)
  const window = TIME_AWARE_GREETINGS.find(
    (entry) => minuteOfDay >= entry.startMinute && minuteOfDay < entry.endMinute
  )
  return window?.messages ?? []
}

function getMinuteStamp(date: Date): number {
  return Math.floor(date.getTime() / 60000)
}

function pickRandomGreeting(messages: GreetingCopy[], previousId: string | null): GreetingCopy {
  if (messages.length === 0) return PLAYFUL_GREETINGS[0]
  if (messages.length === 1) return messages[0]

  const filtered = previousId ? messages.filter((message) => message.id !== previousId) : messages
  const candidates = filtered.length > 0 ? filtered : messages
  const index = Math.floor(Math.random() * candidates.length)
  return candidates[index]
}

function pickWeightedGreetingPool(pools: WeightedGreetingPool[]): WeightedGreetingPool {
  if (pools.length === 1) return pools[0]
  const totalWeight = pools.reduce((sum, pool) => sum + pool.weight, 0)
  if (totalWeight <= 0) return pools[0]

  let threshold = Math.random() * totalWeight
  for (const pool of pools) {
    threshold -= pool.weight
    if (threshold <= 0) return pool
  }
  return pools[pools.length - 1]
}

function chooseGreeting(previousId: string | null, now: Date): GreetingSelection {
  const bucket = getTimeBucket(now)
  const timeAware = getTimeAwareGreetings(now)
  const dayAware = getDayAwareGreetings(now)
  const playful = [...PLAYFUL_GREETINGS]

  const pools: WeightedGreetingPool[] = []
  if (timeAware.length > 0) {
    pools.push({ messages: timeAware, weight: GREETING_WEIGHT_TIME_AWARE })
  }
  if (dayAware.length > 0) {
    pools.push({ messages: dayAware, weight: GREETING_WEIGHT_DAY_AWARE })
  }
  if (playful.length > 0) {
    pools.push({ messages: playful, weight: GREETING_WEIGHT_PLAYFUL })
  }

  const fallbackMessages = timeAware.length > 0 ? timeAware : dayAware.length > 0 ? dayAware : playful
  if (pools.length === 0) {
    pools.push({ messages: fallbackMessages, weight: 1 })
  }

  const selectedPool = pickWeightedGreetingPool(pools)
  let greeting = pickRandomGreeting(selectedPool.messages, previousId)
  if (previousId && greeting.id === previousId) {
    const alternatives = pools
      .flatMap((pool) => pool.messages)
      .filter((candidate) => candidate.id !== previousId)
    if (alternatives.length > 0) {
      greeting = pickRandomGreeting(alternatives, previousId)
    }
  }

  return {
    id: greeting.id,
    primary: greeting.primary,
    subline: greeting.subline,
    bucket
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function smoothStep(t: number): number {
  return t * t * (3 - 2 * t)
}

function lerpColor(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t))
  ]
}

function getAdaptivePalette(date: Date): BucketPalette {
  const hour = date.getHours() + date.getMinutes() / 60

  for (let i = 0; i < SKY_COLOR_KEYFRAMES.length - 1; i++) {
    const current = SKY_COLOR_KEYFRAMES[i]
    const next = SKY_COLOR_KEYFRAMES[i + 1]

    if (hour < current.hour || hour > next.hour) continue

    const segmentLength = next.hour - current.hour
    const rawT = segmentLength <= 0 ? 0 : (hour - current.hour) / segmentLength
    const t = smoothStep(Math.max(0, Math.min(rawT, 1)))

    return {
      top: lerpColor(current.top, next.top, t),
      mid: lerpColor(current.mid, next.mid, t),
      bottom: lerpColor(current.bottom, next.bottom, t),
      starOpacity: lerp(current.stars, next.stars, t) * STAR_OPACITY_SCALE
    }
  }

  const fallback = SKY_COLOR_KEYFRAMES[0]
  return {
    top: fallback.top,
    mid: fallback.mid,
    bottom: fallback.bottom,
    starOpacity: fallback.stars * STAR_OPACITY_SCALE
  }
}

function drawPixelSky(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  palette: BucketPalette
): void {
  const lowWidth = Math.max(1, Math.ceil(width / SKY_PIXEL_SCALE))
  const lowHeight = Math.max(1, Math.ceil(height / SKY_PIXEL_SCALE))

  if (canvas.width !== lowWidth || canvas.height !== lowHeight) {
    canvas.width = lowWidth
    canvas.height = lowHeight
  }

  const imageData = context.createImageData(lowWidth, lowHeight)
  const data = imageData.data

  for (let y = 0; y < lowHeight; y++) {
    const t = lowHeight <= 1 ? 0 : y / (lowHeight - 1)
    const tCurved = Math.pow(t, 0.7)

    let rgb: [number, number, number]
    if (tCurved < 0.3) {
      rgb = lerpColor(palette.top, palette.mid, tCurved / 0.3)
    } else {
      const bottomBlend = Math.pow((tCurved - 0.3) / 0.7, 1.6)
      rgb = lerpColor(palette.mid, palette.bottom, Math.min(bottomBlend, 1))
    }

    for (let x = 0; x < lowWidth; x++) {
      const index = (y * lowWidth + x) * 4
      data[index] = rgb[0]
      data[index + 1] = rgb[1]
      data[index + 2] = rgb[2]
      data[index + 3] = 255
    }
  }

  context.putImageData(imageData, 0, 0)
}

function createStarField(width: number, height: number): StarField {
  const columns = Math.max(1, Math.ceil(width / STAR_GRID_SIZE))
  const rows = Math.max(1, Math.ceil((height * 0.8) / STAR_GRID_SIZE))
  const starCount = Math.max(24, Math.min(120, Math.round(columns * rows * 0.035)))
  const clusterCount = Math.max(6, Math.min(24, Math.round(starCount * STAR_CLUSTER_RATIO)))

  const stars: PixelStar[] = Array.from({ length: starCount }, () => ({
    gx: Math.floor(Math.random() * columns),
    gy: Math.floor(Math.random() * rows),
    phase: Math.random() * Math.PI * 2,
    freq: 0.24 + Math.random() * 0.48,
    bright: 0.48 + Math.random() * 0.52,
    cross: Math.random() > 0.82
  }))

  const clusters: PixelCluster[] = Array.from({ length: clusterCount }, () => ({
    gx: Math.floor(Math.random() * columns),
    gy: Math.floor(Math.random() * rows)
  }))

  return { stars, clusters }
}

function drawStarField(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  starField: StarField,
  opacity: number,
  timestamp: number
): void {
  context.clearRect(0, 0, width, height)
  if (opacity <= 0.01) return

  for (const cluster of starField.clusters) {
    const clusterOpacity = opacity * 0.065
    context.fillStyle = `rgba(200, 210, 232, ${clusterOpacity})`
    for (let dx = 0; dx < 3; dx++) {
      for (let dy = 0; dy < 2; dy++) {
        context.fillRect(
          (cluster.gx + dx) * STAR_GRID_SIZE,
          (cluster.gy + dy) * STAR_GRID_SIZE,
          STAR_PIXEL_SIZE,
          STAR_PIXEL_SIZE
        )
      }
    }
  }

  const now = timestamp / 1000
  for (const star of starField.stars) {
    const raw = 0.5 + 0.5 * Math.sin(now * star.freq + star.phase)
    const level = Math.floor(raw * 4) / 4
    const alpha = opacity * star.bright * (0.34 + 0.66 * level)

    const x = star.gx * STAR_GRID_SIZE
    const y = star.gy * STAR_GRID_SIZE

    context.fillStyle = `rgba(222, 230, 244, ${alpha})`
    context.fillRect(x, y, STAR_PIXEL_SIZE, STAR_PIXEL_SIZE)

    if (star.cross && level > 0.5) {
      const dim = alpha * 0.34
      context.fillStyle = `rgba(222, 230, 244, ${dim})`
      context.fillRect(x - STAR_PIXEL_SIZE, y, STAR_PIXEL_SIZE, STAR_PIXEL_SIZE)
      context.fillRect(x + STAR_PIXEL_SIZE, y, STAR_PIXEL_SIZE, STAR_PIXEL_SIZE)
      context.fillRect(x, y - STAR_PIXEL_SIZE, STAR_PIXEL_SIZE, STAR_PIXEL_SIZE)
    }
  }
}

function getHomeRecentLimits(viewportWidth: number): HomeRecentLimits {
  if (viewportWidth >= HOME_RECENT_LARGE_BREAKPOINT_PX) {
    return HOME_RECENT_LIMITS_LARGE
  }
  if (viewportWidth >= HOME_RECENT_MEDIUM_BREAKPOINT_PX) {
    return HOME_RECENT_LIMITS_MEDIUM
  }
  return HOME_RECENT_LIMITS_SMALL
}

function getPrimaryContributor(rawArtist: string): string {
  const contributors = splitCollaborators(rawArtist)
  return contributors[0] ?? 'Unknown Artist'
}

function getRecentArtistCandidate(
  track: Pick<HomeTrack, 'artist' | 'artist_names' | 'album_artist' | 'album_artist_names'>,
  mode: LibraryArtistBrowseMode
): string {
  const albumArtist = (track.album_artist ?? '').replace(/\s+/g, ' ').trim()
  if (mode === 'strict') {
    return albumArtist || track.artist.replace(/\s+/g, ' ').trim() || 'Unknown Artist'
  }

  const albumArtistKey = normalizeKey(albumArtist)

  if (albumArtist && !GENERIC_ARTIST_KEYS.has(albumArtistKey)) {
    return getPrimaryContributor(albumArtist)
  }

  if (track.artist_names.length > 0) {
    return track.artist_names[0]
  }
  if (track.album_artist_names.length > 0) {
    return track.album_artist_names[0]
  }

  return getPrimaryContributor(track.artist)
}

function formatHomeClockTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)
}

function formatHomeClockDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  }).format(date)
}

export default function HomeView() {
  const totalTrackCount = useLibraryStore((s) => s.totalTrackCount)
  const totalTrackDuration = useLibraryStore((s) => s.totalTrackDuration)
  const albums = useLibraryStore((s) => s.albums as HomeAlbum[])
  const artists = useLibraryStore((s) => s.artists as HomeArtist[])
  const artistBrowseMode = useLibraryStore((s) => s.artistBrowseMode)
  const recentlyPlayedPaths = useLibraryStore((s) => s.recentlyPlayedPaths)
  const favoriteTrackPaths = useLibraryStore((s) => s.favoriteTrackPaths)
  const trackCacheVersion = useLibraryStore((s) => s.trackCacheVersion)
  const resolveTrackPaths = useLibraryStore((s) => s.resolveTrackPaths)
  const setLibraryViewMode = useLibraryStore((s) => s.setViewMode)
  const selectAlbum = useLibraryStore((s) => s.selectAlbum)
  const selectArtist = useLibraryStore((s) => s.selectArtist)
  const currentTrackPath = usePlayerStore((s) => s.currentTrack?.path ?? null)
  const startPlaybackContextByPaths = usePlayerStore((s) => s.startPlaybackContextByPaths)
  const playlists = usePlaylistStore((s) => s.playlists)
  const selectedPlaylistId = usePlaylistStore((s) => s.selectedPlaylistId)
  const loadPlaylists = usePlaylistStore((s) => s.loadPlaylists)
  const createPlaylistWithOptions = usePlaylistStore((s) => s.createPlaylistWithOptions)
  const createDynamicPlaylistWithOptions = usePlaylistStore((s) => s.createDynamicPlaylistWithOptions)
  const previewDynamicPlaylist = usePlaylistStore((s) => s.previewDynamicPlaylist)
  const selectPlaylist = usePlaylistStore((s) => s.selectPlaylist)
  const importPlaylistFromFile = usePlaylistStore((s) => s.importPlaylistFromFile)
  const activeView = useUIStore((s) => s.activeView)
  const homeGreetingTextMode = useUIStore((s) => s.homeGreetingTextMode)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const openCollectionQueueMenu = useUIStore((s) => s.openCollectionQueueMenu)

  const [isCreatePlaylistModalOpen, setIsCreatePlaylistModalOpen] = useState(false)
  const recentlyPlayed = useMemo(
    () => resolveTrackPaths(recentlyPlayedPaths) as HomeTrack[],
    [recentlyPlayedPaths, resolveTrackPaths, trackCacheVersion]
  )
  const favoriteTracks = useMemo(
    () => resolveTrackPaths(favoriteTrackPaths) as HomeTrack[],
    [favoriteTrackPaths, resolveTrackPaths, trackCacheVersion]
  )
  const [playlistImportStatus, setPlaylistImportStatus] = useState<PlaylistImportStatus | null>(null)
  const [greeting, setGreeting] = useState<GreetingSelection>(() => chooseGreeting(null, new Date()))
  const [clockNow, setClockNow] = useState(() => new Date())
  const [viewportWidth, setViewportWidth] = useState(() => (
    typeof window === 'undefined'
      ? HOME_RECENT_MEDIUM_BREAKPOINT_PX
      : window.innerWidth
  ))
  const greetingCardRef = useRef<HTMLElement | null>(null)
  const skyCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const starCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const recentRowRef = useRef<HTMLDivElement | null>(null)
  const playlistRowRef = useRef<HTMLDivElement | null>(null)
  const hasLibraryContent = totalTrackCount > 0 || albums.length > 0 || artists.length > 0
  const recentLimits = useMemo(() => getHomeRecentLimits(viewportWidth), [viewportWidth])

  useHorizontalWheelScroll(recentRowRef)
  useHorizontalWheelScroll(playlistRowRef)

  useEffect(() => {
    void loadPlaylists()
  }, [loadPlaylists])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const now = new Date()
      setGreeting((current) => chooseGreeting(current.id, now))
    }, GREETING_ROTATION_MS)
    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    if (homeGreetingTextMode !== 'clock') return

    let intervalId: number | null = null
    const updateClock = () => setClockNow(new Date())
    updateClock()

    const now = new Date()
    const msUntilNextMinute = 60000 - (now.getSeconds() * 1000 + now.getMilliseconds())
    const timeoutId = window.setTimeout(() => {
      updateClock()
      intervalId = window.setInterval(updateClock, 60000)
    }, Math.max(100, msUntilNextMinute))

    return () => {
      window.clearTimeout(timeoutId)
      if (intervalId !== null) {
        window.clearInterval(intervalId)
      }
    }
  }, [homeGreetingTextMode])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleResize = () => {
      setViewportWidth(window.innerWidth)
    }

    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  useEffect(() => {
    if (!playlistImportStatus) return
    const timeoutId = window.setTimeout(() => {
      setPlaylistImportStatus(null)
    }, 9000)
    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [playlistImportStatus])

  useEffect(() => {
    if (!hasLibraryContent) return

    const card = greetingCardRef.current
    const skyCanvas = skyCanvasRef.current
    const starCanvas = starCanvasRef.current
    if (!card || !skyCanvas || !starCanvas) return

    const skyContext = skyCanvas.getContext('2d')
    const starContext = starCanvas.getContext('2d')
    if (!skyContext || !starContext) return

    let width = 0
    let height = 0
    let starField: StarField = createStarField(1, 1)
    let rafId: number | null = null
    let lastSkyMinute = -1
    let isActive = true
    let currentPalette = getAdaptivePalette(new Date())

    const applyCardTint = (palette: BucketPalette) => {
      card.style.setProperty(
        '--home-greeting-top-color',
        `rgba(${palette.top[0]}, ${palette.top[1]}, ${palette.top[2]}, 0.62)`
      )
    }

    const syncCanvasDimensions = () => {
      const nextWidth = Math.max(1, Math.floor(card.clientWidth))
      const nextHeight = Math.max(1, Math.floor(card.clientHeight))
      if (nextWidth === width && nextHeight === height) return

      width = nextWidth
      height = nextHeight
      starField = createStarField(width, height)

      starCanvas.width = width
      starCanvas.height = height

      drawPixelSky(skyCanvas, skyContext, width, height, currentPalette)
      applyCardTint(currentPalette)
      lastSkyMinute = getMinuteStamp(new Date())
    }

    const syncPaletteFromNow = (now: Date) => {
      currentPalette = getAdaptivePalette(now)
      drawPixelSky(skyCanvas, skyContext, width, height, currentPalette)
      applyCardTint(currentPalette)
      lastSkyMinute = getMinuteStamp(now)
    }

    const syncClockState = (forceGreeting = false) => {
      const now = new Date()
      const currentMinute = getMinuteStamp(now)
      const minuteChanged = currentMinute !== lastSkyMinute

      if (minuteChanged) {
        syncPaletteFromNow(now)
      }
      if (forceGreeting) {
        setGreeting((current) => chooseGreeting(current.id, now))
      }
    }

    const drawFrame = (timestamp: number) => {
      if (!isActive) return

      syncClockState()

      drawStarField(starContext, width, height, starField, currentPalette.starOpacity, timestamp)
      rafId = window.requestAnimationFrame(drawFrame)
    }

    const startAnimation = () => {
      if (rafId !== null) return
      rafId = window.requestAnimationFrame(drawFrame)
    }

    const stopAnimation = () => {
      if (rafId === null) return
      window.cancelAnimationFrame(rafId)
      rafId = null
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopAnimation()
        return
      }
      lastSkyMinute = -1
      syncClockState()
      startAnimation()
    }

    const resizeObserver = new ResizeObserver(() => syncCanvasDimensions())
    resizeObserver.observe(card)

    syncCanvasDimensions()
    syncClockState()
    startAnimation()
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      isActive = false
      stopAnimation()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      resizeObserver.disconnect()
    }
  }, [hasLibraryContent])

  const artistByKey = useMemo(() => {
    const map = new Map<string, HomeArtist>()
    for (const artist of artists) {
      const key = normalizeKey(artist.artist)
      if (!key || map.has(key)) continue
      map.set(key, artist)
    }
    return map
  }, [artists])

  const albumByKey = useMemo(() => {
    const map = new Map<string, HomeAlbum>()
    for (const album of albums) {
      const key = buildAlbumKey(album.album, album.artist)
      if (map.has(key)) continue
      map.set(key, album)
    }
    return map
  }, [albums])

  const albumByIdentityKey = useMemo(() => {
    const map = new Map<string, HomeAlbum>()
    for (const album of albums) {
      if (map.has(album.identity_key)) continue
      map.set(album.identity_key, album)
    }
    return map
  }, [albums])

  const recentTracks = useMemo(() => {
    const seenTrackPaths = new Set<string>()
    const uniqueTracks: HomeTrack[] = []
    for (const track of recentlyPlayed) {
      if (seenTrackPaths.has(track.path)) continue
      seenTrackPaths.add(track.path)
      uniqueTracks.push(track)
    }
    return uniqueTracks
  }, [recentlyPlayed])

  const recentArtists = useMemo(() => {
    const seenArtistKeys = new Set<string>()
    const uniqueArtists: HomeArtist[] = []

    for (const track of recentlyPlayed) {
      const candidateArtist = getRecentArtistCandidate(track, artistBrowseMode) || 'Unknown Artist'
      const key = normalizeKey(candidateArtist)
      if (!key || seenArtistKeys.has(key)) continue
      seenArtistKeys.add(key)

      const metadata = artistByKey.get(key)
      uniqueArtists.push({
        artist: metadata?.artist ?? candidateArtist,
        track_count: metadata?.track_count ?? 0,
        artwork_hash: metadata?.artwork_hash ?? track.artwork_hash
      })

      if (uniqueArtists.length >= recentLimits.artist) {
        break
      }
    }

    return uniqueArtists
  }, [artistBrowseMode, recentlyPlayed, artistByKey, recentLimits])

  const recentAlbums = useMemo(() => {
    const seenAlbumIdentityKeys = new Set<string>()
    const uniqueAlbums: HomeAlbum[] = []

    for (const track of recentlyPlayed) {
      const identityKey = track.album_identity_key || buildAlbumIdentityKeyFromTrack(track)
      const identityArtist = getAlbumIdentityArtist(track)
      const fallbackKey = buildAlbumKey(track.album, identityArtist)
      const metadata = albumByIdentityKey.get(identityKey) ?? albumByKey.get(fallbackKey)
      if (!metadata) continue

      if (seenAlbumIdentityKeys.has(metadata.identity_key)) continue
      seenAlbumIdentityKeys.add(metadata.identity_key)
      uniqueAlbums.push({
        identity_key: metadata.identity_key,
        album: metadata.album,
        artist: metadata.artist,
        year: metadata.year,
        artwork_hash: metadata.artwork_hash,
        track_count: metadata.track_count
      })

      if (uniqueAlbums.length >= recentLimits.album) break
    }

    return uniqueAlbums
  }, [recentlyPlayed, albumByIdentityKey, albumByKey, recentLimits])

  const homePlaylists = useMemo(
    () => buildPlaylistDisplaySections(playlists, {
      trackCount: favoriteTracks.length,
      topArtworkHash: favoriteTracks[0]?.artwork_hash ?? null
    }, 3).homePlaylists,
    [playlists, favoriteTracks]
  )

  const clockGreeting = useMemo(() => ({
    primary: formatHomeClockTime(clockNow),
    subline: formatHomeClockDate(clockNow)
  }), [clockNow])

  const handlePlayRecentList = async (_track: HomeTrack, index: number) => {
    await startPlaybackContextByPaths(recentTracks.map((recentTrack) => recentTrack.path), index, {
      contextLabel: 'Recently Played'
    })
  }

  const handleCreatePlaylist = async (name: string, coverImagePath: string | null) => {
    const playlist = await createPlaylistWithOptions({ name, coverImagePath })
    await selectPlaylist(playlist.id)
    setActiveView('playlist')
  }

  const handleCreateDynamicPlaylist = async (name: string, coverImagePath: string | null, rules: DynamicPlaylistRulesV1) => {
    const playlist = await createDynamicPlaylistWithOptions({ name, coverImagePath, rules })
    await selectPlaylist(playlist.id)
    setActiveView('playlist')
  }

  const handleOpenPlaylist = async (playlistId: number) => {
    await selectPlaylist(playlistId)
    setActiveView('playlist')
  }

  const handleImportPlaylist = async () => {
    try {
      const result = await importPlaylistFromFile()
      if (!result) return

      setPlaylistImportStatus(formatPlaylistImportStatus(result))

      if (result.playlistId !== null && result.playlistId > 0 && result.importedCount + result.missingEntryCount > 0) {
        await selectPlaylist(result.playlistId)
        setActiveView('playlist')
      }
    } catch (error) {
      console.error('Failed to import playlist:', error)
      const message = error instanceof Error ? error.message : 'Failed to import playlist.'
      setPlaylistImportStatus({ tone: 'error', message })
    }
  }

  const handleOpenArtist = async (artistName: string) => {
    setLibraryViewMode('artists')
    await selectArtist(artistName, 'home')
    setActiveView('library')
  }

  const handleOpenAlbum = async (album: HomeAlbum) => {
    setLibraryViewMode('albums')
    await selectAlbum(album.album, album.artist, 'home', album.identity_key)
    setActiveView('library')
  }

  const handleOpenArtistsLibrary = () => {
    setLibraryViewMode('artists')
    setActiveView('library')
  }

  const handleOpenAlbumsLibrary = () => {
    setLibraryViewMode('albums')
    setActiveView('library')
  }

  if (!hasLibraryContent) {
    return (
      <div className="home-view">
        <div className="home-placeholder">
          <div className="home-placeholder-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          </div>
          <h2>Home</h2>
          <p>Add a folder in Library to populate this dashboard.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="home-view">
      <div className="home-content" data-controller-scroll>
        <section ref={greetingCardRef} className={`home-greeting-card is-${greeting.bucket}`}>
          <canvas ref={skyCanvasRef} className="home-greeting-sky-canvas" aria-hidden="true" />
          <canvas ref={starCanvasRef} className="home-greeting-star-canvas" aria-hidden="true" />
          {homeGreetingTextMode === 'off' ? (
            <div className="home-greeting-content" aria-hidden="true" />
          ) : (
            <div className="home-greeting-content">
              <h1 className="home-greeting-message">
                {homeGreetingTextMode === 'clock' ? clockGreeting.primary : greeting.primary}
              </h1>
              {(homeGreetingTextMode === 'clock' ? clockGreeting.subline : greeting.subline).trim().length > 0 && (
                <p className="home-greeting-subline">
                  {homeGreetingTextMode === 'clock' ? clockGreeting.subline : greeting.subline}
                </p>
              )}
            </div>
          )}
          <div className="home-greeting-stats">
            <div className="home-greeting-stat home-greeting-stat-duration">
              <span className="home-greeting-stat-label">Total Time</span>
              <span className="home-greeting-stat-value">{formatExactDuration(totalTrackDuration)}</span>
            </div>
            <div className="home-greeting-stat">
              <span className="home-greeting-stat-label">Tracks</span>
              <span className="home-greeting-stat-value">{totalTrackCount}</span>
            </div>
            <div className="home-greeting-stat">
              <span className="home-greeting-stat-label">Albums</span>
              <span className="home-greeting-stat-value">{albums.length}</span>
            </div>
            <div className="home-greeting-stat">
              <span className="home-greeting-stat-label">Artists</span>
              <span className="home-greeting-stat-value">{artists.length}</span>
            </div>
          </div>
        </section>

        <section className="home-section" data-controller-group="home-recent-tracks" data-controller-axis="horizontal">
          <div className="home-section-header">
            <h2>RECENTLY PLAYED</h2>
          </div>
          {recentTracks.length > 0 ? (
            <div className="home-recent-row" ref={recentRowRef}>
              {recentTracks.map((track, index) => (
                <article
                  key={track.path}
                  className={`home-track-card ${currentTrackPath === track.path ? 'active' : ''}`}
                  onClick={() => handlePlayRecentList(track, index)}
                  data-controller-focusable="true"
                  data-controller-key={`home-track:${track.path}`}
                  tabIndex={-1}
                  role="button"
                  aria-label={`Play ${track.title} by ${track.artist}`}
                >
                  <div className="home-track-artwork">
                    {track.artwork_hash ? (
                      <AlbumArtwork hash={track.artwork_hash} alt={track.album} variant="card" />
                    ) : (
                      <span>&#9835;</span>
                    )}
                  </div>
                  <div className="home-track-meta">
                    <div className="home-track-title">{track.title}</div>
                    <div className="home-track-artist">{track.artist}</div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="home-empty-strip">No recent tracks yet. Start playing music!</div>
          )}
        </section>

        <section className="home-section" data-controller-group="home-recent-artists" data-controller-axis="grid">
          <div className="home-section-header">
            <h2>RECENT ARTISTS</h2>
            <div className="home-section-actions">
              <button className="home-section-link-btn" onClick={handleOpenArtistsLibrary}>
                Open Library
              </button>
            </div>
          </div>
          {recentArtists.length > 0 ? (
            <div className="home-artist-grid">
              {recentArtists.map((artist) => (
                <div
                  key={artist.artist}
                  className="home-artist-chip"
                  onClick={() => handleOpenArtist(artist.artist)}
                  data-controller-focusable="true"
                  data-controller-key={`home-artist:${artist.artist}`}
                  tabIndex={-1}
                  role="button"
                  aria-label={`Open ${artist.artist}`}
                >
                  <div className="home-artist-avatar">
                    {artist.artwork_hash ? (
                      <AlbumArtwork
                        hash={artist.artwork_hash}
                        alt={`${artist.artist} artwork`}
                        className="home-artist-artwork"
                        variant="card"
                      />
                    ) : (
                      artistInitial(artist.artist)
                    )}
                  </div>
                  <div className="home-artist-name">{artist.artist}</div>
                  <div className="home-artist-count">
                    {artist.track_count > 0 ? `${artist.track_count} tracks` : 'Recent play'}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="home-empty-strip">No recent artists yet. Play a few tracks first.</div>
          )}
        </section>

        <section className="home-section" data-controller-group="home-recent-albums" data-controller-axis="grid">
          <div className="home-section-header">
            <h2>RECENT ALBUMS</h2>
            <div className="home-section-actions">
              <button className="home-section-link-btn" onClick={handleOpenAlbumsLibrary}>
                Open Library
              </button>
            </div>
          </div>
          {recentAlbums.length > 0 ? (
            <div className="home-album-grid">
              {recentAlbums.map((album) => (
                <article
                  key={album.identity_key}
                  className="home-album-card"
                  onClick={() => handleOpenAlbum(album)}
                  data-controller-focusable="true"
                  data-controller-context="true"
                  data-controller-key={`home-album:${album.identity_key}`}
                  tabIndex={-1}
                  role="button"
                  aria-label={`Open ${album.album} by ${album.artist}`}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    openCollectionQueueMenu({
                      target: {
                        kind: 'album',
                        album: album.album,
                        artist: album.artist,
                        identityKey: album.identity_key
                      },
                      x: event.clientX,
                      y: event.clientY
                    })
                  }}
                >
                  <div className="home-album-artwork">
                    {album.artwork_hash ? (
                      <AlbumArtwork hash={album.artwork_hash} alt={album.album} variant="card" />
                    ) : (
                      <span>&#9835;</span>
                    )}
                  </div>
                  <div className="home-album-title">{album.album}</div>
                  <div className="home-album-artist">{album.artist}</div>
                  <div className="home-album-meta">
                    {album.track_count > 0 ? `${album.track_count} tracks` : 'Recent play'}
                    {album.year ? ` \u00b7 ${album.year}` : ''}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="home-empty-strip">No recent albums yet. Your latest albums will appear here.</div>
          )}
        </section>

        <section className="home-section" data-controller-group="home-playlists" data-controller-axis="horizontal">
          <div className="home-section-header">
            <h2>PLAYLISTS</h2>
            <div className="home-section-actions">
              <button
                className="home-section-link-btn"
                onClick={() => void handleImportPlaylist()}
                title="Import playlist"
              >
                Import
              </button>
              <button
                className="home-create-playlist-btn"
                onClick={() => setIsCreatePlaylistModalOpen(true)}
                title="Create playlist"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </div>
          </div>

          {playlistImportStatus && (
            <div className={`home-playlist-import-status home-playlist-import-status-${playlistImportStatus.tone}`}>
              {playlistImportStatus.message}
            </div>
          )}

          {homePlaylists.length > 0 ? (
            <div className="home-playlist-row" ref={playlistRowRef}>
              {homePlaylists.map((playlist) => (
                <article
                  key={playlist.id}
                  className={`home-playlist-rail-card ${activeView === 'playlist' && selectedPlaylistId === playlist.id ? 'active' : ''}`}
                  onClick={() => void handleOpenPlaylist(playlist.id)}
                  data-controller-focusable="true"
                  data-controller-context="true"
                  data-controller-key={`home-playlist:${playlist.id}`}
                  tabIndex={-1}
                  role="button"
                  aria-label={`Open ${playlist.name}`}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    openCollectionQueueMenu({
                      target: { kind: 'playlist', playlistId: playlist.id, name: playlist.name },
                      x: event.clientX,
                      y: event.clientY
                    })
                  }}
                >
                  <PlaylistCover
                    hash={playlist.cover_hash}
                    name={playlist.name}
                    isFavorites={playlist.isSystemFavorites}
                    className="home-playlist-rail-cover"
                  />
                  <div className="home-playlist-rail-meta">
                    <div className="home-playlist-rail-name">{playlist.name}</div>
                    <div className="home-playlist-rail-count">{playlist.kind === 'dynamic' ? 'Dynamic - ' : ''}{playlist.track_count} tracks</div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="home-empty-strip">No playlists yet. Click + to create one.</div>
          )}
        </section>
      </div>
      <CreatePlaylistModal
        isOpen={isCreatePlaylistModalOpen}
        onClose={() => setIsCreatePlaylistModalOpen(false)}
        onCreate={handleCreatePlaylist}
        onCreateDynamic={handleCreateDynamicPlaylist}
        onPreviewDynamic={previewDynamicPlaylist}
        allowDynamic
      />
    </div>
  )
}
