import { ASTRA_SESSION_STATE_STORAGE_KEY } from '../constants/settingsStorageKeys'
import type { TrackSourceType } from '../../types/subsonic'
import type { LibraryYearKey } from './libraryYears'

export const SESSION_STATE_KIND = 'astra-session-state'
export const SESSION_STATE_SCHEMA_VERSION = 1

export type SessionAppView = 'home' | 'library' | 'stats' | 'graph' | 'eq' | 'settings' | 'playlist'
export type SessionTrackSortKey = 'title' | 'artist' | 'album' | 'genre' | 'duration' | 'bpm' | 'musical_key' | 'added' | 'rating' | 'play_count'
export type SessionSortDirection = 'asc' | 'desc'
export type SessionViewMode = 'tracks' | 'albums' | 'artists' | 'genres' | 'years' | 'folders'
export type SessionAlbumSortMode = 'title' | 'artist'
export type SessionArtistRootViewMode = 'list' | 'grid'
export type SessionQueueItemOrigin = 'context' | 'manual'
export type SessionQueueTrackSource = SessionQueueItemOrigin | 'standalone'
export type SessionRepeatMode = 'none' | 'one' | 'all'

export interface SessionTrackSortState {
  key: SessionTrackSortKey
  direction: SessionSortDirection
}

export interface SessionPlaybackSourceContext {
  type: 'playlist' | 'artist' | 'album' | 'genre'
  playlistId?: number
  artist?: string
  album?: string
  albumArtist?: string
  identityKey?: string
  genre?: string
}

export interface SessionQueueTrackSnapshot {
  id: string
  path: string
  origin?: 'library' | 'associated-external'
  title: string
  artist: string
  artistNames?: string[]
  album: string
  albumArtist?: string
  albumArtistNames?: string[]
  albumIdentityKey?: string
  duration: number
  trackNumber?: number
  discNumber?: number
  year?: number
  genre?: string
  genres?: string[]
  artworkHash?: string
  format: string
  sampleRate?: number
  bitDepth?: number
  bitrate?: number
  channels?: number
  codec?: string
  codecProfile?: string
  isAtmosJoc?: boolean
  replayGainTrackDb?: number
  replayGainAlbumDb?: number
  sourceType?: TrackSourceType
  sourceId?: number
  sourceTrackId?: string
  sourcePath?: string
  isAvailable?: boolean
  availabilityReason?: string
}

export interface SessionQueueTrackEntry {
  path: string
  snapshot: SessionQueueTrackSnapshot
}

export interface SessionQueueItem {
  queueId: string
  entry: SessionQueueTrackEntry
  origin: SessionQueueItemOrigin
  sourcePlaylistId: number | null
  sourceContext: SessionPlaybackSourceContext | null
  contextLabel: string | null
}

export interface SessionPlaybackHistoryEntry {
  item: SessionQueueItem
}

export interface PlayerSessionSnapshot {
  currentTrack: SessionQueueTrackSnapshot | null
  currentTrackSource: SessionQueueTrackSource
  savedPlaybackState: 'playing' | 'paused' | 'stopped' | 'loading'
  currentTime: number
  duration: number
  queueItems: SessionQueueItem[]
  baseUpcomingQueueIds: string[]
  upcomingQueueIds: string[]
  currentQueueItemId: string | null
  queueSourcePlaylistId: number | null
  queueSourceContext: SessionPlaybackSourceContext | null
  queueContextLabel: string | null
  shuffle: boolean
  repeat: SessionRepeatMode
  playbackHistory: SessionPlaybackHistoryEntry[]
}

export interface UISessionSnapshot {
  activeView: SessionAppView
  showQueue: boolean
  showInfoSidebar: boolean
  showPipelineShelf: boolean
  showLyricsShelf: boolean
  lyricsShelfExpanded: boolean
  fullscreenLyricsVisible?: boolean
}

export interface LibrarySessionSnapshot {
  viewMode: SessionViewMode
  selectedAlbum: {
    identity_key?: string
    album: string
    artist: string
    is_new?: boolean
  } | null
  selectedArtist: string | null
  selectedGenre: string | null
  selectedYear: LibraryYearKey | null
  trackListSortState: SessionTrackSortState | null
  tracksViewSortState?: SessionTrackSortState | null
  selectedSourceFilters: string[]
  albumSortMode: SessionAlbumSortMode
  includeSinglesInAlbums: boolean
  includeCollabArtists: boolean
  artistRootViewMode: SessionArtistRootViewMode
}

export interface PlaylistSessionSnapshot {
  selectedPlaylistId: number | null
  sortState: SessionTrackSortState | null
}

export interface SessionSnapshotV1 {
  kind: typeof SESSION_STATE_KIND
  schemaVersion: typeof SESSION_STATE_SCHEMA_VERSION
  savedAt: number
  player: PlayerSessionSnapshot | null
  ui: UISessionSnapshot | null
  library: LibrarySessionSnapshot | null
  playlist: PlaylistSessionSnapshot | null
}

export type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function optionalString(value: unknown): string | undefined {
  const normalized = stringValue(value)
  return normalized ?? undefined
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function optionalFiniteNumber(value: unknown): number | undefined {
  const normalized = finiteNumber(value)
  return normalized ?? undefined
}

function nonNegativeNumber(value: unknown): number {
  const normalized = finiteNumber(value)
  return normalized === null ? 0 : Math.max(0, normalized)
}

function integerOrNull(value: unknown): number | null {
  const normalized = finiteNumber(value)
  return normalized === null ? null : Math.trunc(normalized)
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return out.length > 0 ? out : undefined
}

function requiredStringArray(value: unknown): string[] {
  return stringArray(value) ?? []
}

function normalizeTrackSourceType(value: unknown): TrackSourceType | undefined {
  return value === 'local' || value === 'subsonic' || value === 'jellyfin'
    ? value
    : undefined
}

export function normalizeTrackSortState(value: unknown): SessionTrackSortState | null {
  if (!isPlainRecord(value)) return null
  const key = value.key
  const direction = value.direction
  if (
    key !== 'title'
    && key !== 'artist'
    && key !== 'album'
    && key !== 'genre'
    && key !== 'duration'
    && key !== 'bpm'
    && key !== 'musical_key'
    && key !== 'added'
    && key !== 'rating'
    && key !== 'play_count'
  ) {
    return null
  }
  return {
    key,
    direction: direction === 'desc' ? 'desc' : 'asc'
  }
}

export function normalizeAppView(value: unknown): SessionAppView {
  return value === 'library'
    || value === 'stats'
    || value === 'graph'
    || value === 'eq'
    || value === 'settings'
    || value === 'playlist'
    || value === 'home'
    ? value
    : 'home'
}

function normalizeViewMode(value: unknown): SessionViewMode {
  return value === 'albums' || value === 'artists' || value === 'genres' || value === 'years' || value === 'folders' || value === 'tracks'
    ? value
    : 'tracks'
}

function normalizeLibraryYearKey(value: unknown): LibraryYearKey | null {
  if (value === 'unknown') return value
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function normalizeAlbumSortMode(value: unknown): SessionAlbumSortMode {
  return value === 'artist' ? 'artist' : 'title'
}

function normalizeArtistRootViewMode(value: unknown): SessionArtistRootViewMode {
  return value === 'grid' ? 'grid' : 'list'
}

function normalizeQueueItemOrigin(value: unknown): SessionQueueItemOrigin {
  return value === 'context' ? 'context' : 'manual'
}

function normalizeQueueTrackSource(value: unknown): SessionQueueTrackSource {
  return value === 'context' || value === 'manual' || value === 'standalone'
    ? value
    : 'standalone'
}

function normalizeRepeatMode(value: unknown): SessionRepeatMode {
  return value === 'all' || value === 'one' ? value : 'none'
}

function normalizePlaybackSourceContext(value: unknown): SessionPlaybackSourceContext | null {
  if (!isPlainRecord(value)) return null

  if (value.type === 'playlist') {
    const playlistId = integerOrNull(value.playlistId)
    return playlistId === null ? null : { type: 'playlist', playlistId }
  }

  if (value.type === 'artist') {
    const artist = stringValue(value.artist)
    return artist ? { type: 'artist', artist } : null
  }

  if (value.type === 'genre') {
    const genre = stringValue(value.genre)
    return genre ? { type: 'genre', genre } : null
  }

  if (value.type === 'album') {
    const album = stringValue(value.album)
    if (!album) return null
    return {
      type: 'album',
      album,
      albumArtist: optionalString(value.albumArtist),
      identityKey: optionalString(value.identityKey)
    }
  }

  return null
}

function normalizeQueueTrackSnapshot(value: unknown): SessionQueueTrackSnapshot | null {
  if (!isPlainRecord(value)) return null
  const path = stringValue(value.path)
  if (!path) return null

  const id = stringValue(value.id) ?? path
  const title = stringValue(value.title) ?? path.split(/[\\/]/).pop() ?? 'Unknown Track'
  const artist = stringValue(value.artist) ?? 'Unknown Artist'
  const album = stringValue(value.album) ?? 'Unknown Album'
  const format = stringValue(value.format) ?? 'unknown'
  const origin = value.origin === 'associated-external' || value.origin === 'library' ? value.origin : undefined
  const sourceType = normalizeTrackSourceType(value.sourceType)
  const trackNumber = optionalFiniteNumber(value.trackNumber)
  const discNumber = optionalFiniteNumber(value.discNumber)
  const year = optionalFiniteNumber(value.year)
  const sampleRate = optionalFiniteNumber(value.sampleRate)
  const bitDepth = optionalFiniteNumber(value.bitDepth)
  const bitrate = optionalFiniteNumber(value.bitrate)
  const channels = optionalFiniteNumber(value.channels)
  const replayGainTrackDb = optionalFiniteNumber(value.replayGainTrackDb)
  const replayGainAlbumDb = optionalFiniteNumber(value.replayGainAlbumDb)
  const sourceId = optionalFiniteNumber(value.sourceId)

  return {
    id,
    path,
    ...(origin ? { origin } : {}),
    title,
    artist,
    ...(stringArray(value.artistNames) ? { artistNames: stringArray(value.artistNames) } : {}),
    album,
    ...(optionalString(value.albumArtist) ? { albumArtist: optionalString(value.albumArtist) } : {}),
    ...(stringArray(value.albumArtistNames) ? { albumArtistNames: stringArray(value.albumArtistNames) } : {}),
    ...(optionalString(value.albumIdentityKey) ? { albumIdentityKey: optionalString(value.albumIdentityKey) } : {}),
    duration: nonNegativeNumber(value.duration),
    ...(trackNumber !== undefined ? { trackNumber } : {}),
    ...(discNumber !== undefined ? { discNumber } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(optionalString(value.genre) ? { genre: optionalString(value.genre) } : {}),
    ...(stringArray(value.genres) ? { genres: stringArray(value.genres) } : {}),
    ...(optionalString(value.artworkHash) ? { artworkHash: optionalString(value.artworkHash) } : {}),
    format,
    ...(sampleRate !== undefined ? { sampleRate } : {}),
    ...(bitDepth !== undefined ? { bitDepth } : {}),
    ...(bitrate !== undefined ? { bitrate } : {}),
    ...(channels !== undefined ? { channels } : {}),
    ...(optionalString(value.codec) ? { codec: optionalString(value.codec) } : {}),
    ...(optionalString(value.codecProfile) ? { codecProfile: optionalString(value.codecProfile) } : {}),
    ...(typeof value.isAtmosJoc === 'boolean' ? { isAtmosJoc: value.isAtmosJoc } : {}),
    ...(replayGainTrackDb !== undefined ? { replayGainTrackDb } : {}),
    ...(replayGainAlbumDb !== undefined ? { replayGainAlbumDb } : {}),
    ...(sourceType ? { sourceType } : {}),
    ...(sourceId !== undefined ? { sourceId } : {}),
    ...(optionalString(value.sourceTrackId) ? { sourceTrackId: optionalString(value.sourceTrackId) } : {}),
    ...(optionalString(value.sourcePath) ? { sourcePath: optionalString(value.sourcePath) } : {}),
    ...(typeof value.isAvailable === 'boolean' ? { isAvailable: value.isAvailable } : {}),
    ...(optionalString(value.availabilityReason) ? { availabilityReason: optionalString(value.availabilityReason) } : {})
  }
}

function normalizeQueueTrackEntry(value: unknown): SessionQueueTrackEntry | null {
  if (!isPlainRecord(value)) return null
  const snapshot = normalizeQueueTrackSnapshot(value.snapshot)
  const path = stringValue(value.path) ?? snapshot?.path
  if (!path || !snapshot) return null
  return {
    path,
    snapshot: {
      ...snapshot,
      path
    }
  }
}

function normalizeQueueItem(value: unknown): SessionQueueItem | null {
  if (!isPlainRecord(value)) return null
  const queueId = stringValue(value.queueId)
  const entry = normalizeQueueTrackEntry(value.entry)
  if (!queueId || !entry) return null

  return {
    queueId,
    entry,
    origin: normalizeQueueItemOrigin(value.origin),
    sourcePlaylistId: integerOrNull(value.sourcePlaylistId),
    sourceContext: normalizePlaybackSourceContext(value.sourceContext),
    contextLabel: stringValue(value.contextLabel)
  }
}

function normalizeQueueItems(value: unknown): SessionQueueItem[] {
  if (!Array.isArray(value)) return []
  const out: SessionQueueItem[] = []
  const seenIds = new Set<string>()
  for (const item of value) {
    const normalized = normalizeQueueItem(item)
    if (!normalized || seenIds.has(normalized.queueId)) continue
    seenIds.add(normalized.queueId)
    out.push(normalized)
  }
  return out
}

function filterQueueIds(value: unknown, validIds: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !validIds.has(item) || out.includes(item)) continue
    out.push(item)
  }
  return out
}

function normalizePlaybackHistory(value: unknown): SessionPlaybackHistoryEntry[] {
  if (!Array.isArray(value)) return []
  const out: SessionPlaybackHistoryEntry[] = []
  for (const entry of value) {
    if (!isPlainRecord(entry)) continue
    const item = normalizeQueueItem(entry.item)
    if (!item) continue
    out.push({ item })
  }
  return out
}

function normalizePlayerSession(value: unknown): PlayerSessionSnapshot | null {
  if (!isPlainRecord(value)) return null

  const queueItems = normalizeQueueItems(value.queueItems)
  const validIds = new Set(queueItems.map((item) => item.queueId))
  const currentQueueItemId = stringValue(value.currentQueueItemId)
  const currentTrack = normalizeQueueTrackSnapshot(value.currentTrack)
  const savedPlaybackState = value.savedPlaybackState === 'playing'
    || value.savedPlaybackState === 'loading'
    || value.savedPlaybackState === 'paused'
    || value.savedPlaybackState === 'stopped'
    ? value.savedPlaybackState
    : 'stopped'

  return {
    currentTrack,
    currentTrackSource: normalizeQueueTrackSource(value.currentTrackSource),
    savedPlaybackState,
    currentTime: nonNegativeNumber(value.currentTime),
    duration: nonNegativeNumber(value.duration),
    queueItems,
    baseUpcomingQueueIds: filterQueueIds(value.baseUpcomingQueueIds, validIds),
    upcomingQueueIds: filterQueueIds(value.upcomingQueueIds, validIds),
    currentQueueItemId: currentQueueItemId && validIds.has(currentQueueItemId) ? currentQueueItemId : null,
    queueSourcePlaylistId: integerOrNull(value.queueSourcePlaylistId),
    queueSourceContext: normalizePlaybackSourceContext(value.queueSourceContext),
    queueContextLabel: stringValue(value.queueContextLabel),
    shuffle: value.shuffle === true,
    repeat: normalizeRepeatMode(value.repeat),
    playbackHistory: normalizePlaybackHistory(value.playbackHistory)
  }
}

function normalizeUISession(value: unknown): UISessionSnapshot | null {
  if (!isPlainRecord(value)) return null
  return {
    activeView: normalizeAppView(value.activeView),
    showQueue: value.showQueue === true,
    showInfoSidebar: value.showInfoSidebar === true,
    showPipelineShelf: value.showPipelineShelf === true,
    showLyricsShelf: value.showLyricsShelf === true,
    lyricsShelfExpanded: value.lyricsShelfExpanded === true,
    fullscreenLyricsVisible: value.fullscreenLyricsVisible === true
  }
}

function normalizeSelectedAlbum(value: unknown): LibrarySessionSnapshot['selectedAlbum'] {
  if (!isPlainRecord(value)) return null
  const album = stringValue(value.album)
  if (!album) return null
  return {
    album,
    artist: stringValue(value.artist) ?? '',
    ...(optionalString(value.identity_key) ? { identity_key: optionalString(value.identity_key) } : {}),
    ...(typeof value.is_new === 'boolean' ? { is_new: value.is_new } : {})
  }
}

function normalizeLibrarySession(value: unknown): LibrarySessionSnapshot | null {
  if (!isPlainRecord(value)) return null
  return {
    viewMode: normalizeViewMode(value.viewMode),
    selectedAlbum: normalizeSelectedAlbum(value.selectedAlbum),
    selectedArtist: stringValue(value.selectedArtist),
    selectedGenre: stringValue(value.selectedGenre),
    selectedYear: normalizeLibraryYearKey(value.selectedYear),
    trackListSortState: normalizeTrackSortState(value.trackListSortState),
    ...(Object.hasOwn(value, 'tracksViewSortState')
      ? { tracksViewSortState: normalizeTrackSortState(value.tracksViewSortState) }
      : {}),
    selectedSourceFilters: requiredStringArray(value.selectedSourceFilters),
    albumSortMode: normalizeAlbumSortMode(value.albumSortMode),
    includeSinglesInAlbums: value.includeSinglesInAlbums === true,
    includeCollabArtists: value.includeCollabArtists === true,
    artistRootViewMode: normalizeArtistRootViewMode(value.artistRootViewMode)
  }
}

function normalizePlaylistSession(value: unknown): PlaylistSessionSnapshot | null {
  if (!isPlainRecord(value)) return null
  return {
    selectedPlaylistId: integerOrNull(value.selectedPlaylistId),
    sortState: normalizeTrackSortState(value.sortState)
  }
}

export function normalizeSessionSnapshot(value: unknown): SessionSnapshotV1 | null {
  if (!isPlainRecord(value)) return null
  if (value.kind !== SESSION_STATE_KIND) return null
  if (value.schemaVersion !== SESSION_STATE_SCHEMA_VERSION) return null

  return {
    kind: SESSION_STATE_KIND,
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    savedAt: nonNegativeNumber(value.savedAt),
    player: normalizePlayerSession(value.player),
    ui: normalizeUISession(value.ui),
    library: normalizeLibrarySession(value.library),
    playlist: normalizePlaylistSession(value.playlist)
  }
}

export function readSessionSnapshot(storage: SessionStorageLike = localStorage): SessionSnapshotV1 | null {
  try {
    const raw = storage.getItem(ASTRA_SESSION_STATE_STORAGE_KEY)
    if (!raw) return null
    return normalizeSessionSnapshot(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeSessionSnapshot(
  snapshot: SessionSnapshotV1,
  storage: SessionStorageLike = localStorage
): void {
  storage.setItem(ASTRA_SESSION_STATE_STORAGE_KEY, JSON.stringify(snapshot))
}

export function clearSessionSnapshot(storage: SessionStorageLike = localStorage): void {
  storage.removeItem(ASTRA_SESSION_STATE_STORAGE_KEY)
}
