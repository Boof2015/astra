import type { MiniPlayerQueueSnapshot, MiniPlayerSnapshot } from '../../types/miniPlayer'
import type {
  CompanionApiLibraryEvent,
  CompanionApiPlaybackSnapshot,
  CompanionApiQueueSnapshot,
  CompanionApiSearchResponse,
  CompanionApiSearchResult,
  CompanionApiTargetType,
  CompanionApiTrackSummary
} from '../../types/companionApi'
import { formatArtistNames, normalizeArtistNames } from '../../shared/library/artistCredits'
import * as library from './library'
import {
  CompanionApiReferenceSigner,
  type CompanionApiReference
} from './companionApiRefs'
import type { CompanionApiResolvedTarget } from './companionApiV2'

interface CompanionApiLibraryOptions {
  getSigner: () => CompanionApiReferenceSigner
  resolveArtworkByHash: (artworkHash: string) => Promise<string | null>
  onLibraryEvent: (event: CompanionApiLibraryEvent) => void
  onRendererLibraryMutation: () => void
}

interface ScoredSearchResult {
  score: number
  result: CompanionApiSearchResult
}

function safeNumber(value: unknown, fallback: number = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function publicText(value: unknown, maxLength: number = 500): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function publicTextList(values: unknown, maxItems: number = 32, maxLength: number = 200): string[] {
  if (!Array.isArray(values)) return []
  const normalized: string[] = []
  for (const value of values) {
    const text = publicText(value, maxLength)
    if (text && !normalized.includes(text)) normalized.push(text)
    if (normalized.length >= maxItems) break
  }
  return normalized
}

function normalizeNames(names: unknown, fallback: unknown): string[] {
  const parsed = Array.isArray(names) ? publicTextList(normalizeArtistNames(names), 20) : []
  if (parsed.length > 0) return parsed
  const fallbackName = publicText(fallback, 200)
  return fallbackName ? [fallbackName] : []
}

function displayName(names: string[], fallback: unknown): string {
  if (names.length > 1) return formatArtistNames(names)
  const fallbackName = publicText(fallback, 200)
  if (fallbackName) return fallbackName
  return names[0] ?? ''
}

function artworkUrl(ref: string, available: boolean): string | null {
  return available ? `/v2/artwork/${encodeURIComponent(ref)}` : null
}

function searchScore(query: string, fields: readonly string[]): number | null {
  const needle = query.toLocaleLowerCase()
  let best = Number.POSITIVE_INFINITY
  for (const field of fields) {
    const candidate = field.toLocaleLowerCase()
    if (candidate === needle) best = Math.min(best, 0)
    else if (candidate.startsWith(needle)) best = Math.min(best, 1)
    else {
      const index = candidate.indexOf(needle)
      if (index >= 0) best = Math.min(best, 2 + Math.min(index, 100) / 100)
    }
  }
  return Number.isFinite(best) ? best : null
}

function parsePositiveIntegerKey(reference: CompanionApiReference): number | null {
  const value = Number(reference.key)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function isPlayableTrack(track: library.DbTrack): boolean {
  return track.is_available === 1
}

export class CompanionApiLibrary {
  private readonly options: CompanionApiLibraryOptions

  constructor(options: CompanionApiLibraryOptions) {
    this.options = options
  }

  getPlayback(snapshot: MiniPlayerSnapshot | null): CompanionApiPlaybackSnapshot {
    const updatedAt = Date.now()
    if (!snapshot) {
      return {
        state: 'stopped',
        positionSeconds: 0,
        durationSeconds: 0,
        volume: 1,
        muted: false,
        shuffle: false,
        repeat: 'none',
        outputDeviceLabel: null,
        queueCount: 0,
        currentTrack: null,
        updatedAt
      }
    }

    const currentTrack = snapshot.currentTrack
    const dbTrack = currentTrack ? library.getTrackByPath(currentTrack.path) : null
    return {
      state: snapshot.playbackState,
      positionSeconds: Math.max(0, safeNumber(snapshot.currentTime)),
      durationSeconds: Math.max(0, safeNumber(snapshot.duration)),
      volume: Math.max(0, Math.min(1, safeNumber(snapshot.volume, 1))),
      muted: Boolean(snapshot.isMuted),
      shuffle: Boolean(snapshot.shuffle),
      repeat: snapshot.repeat === 'one' || snapshot.repeat === 'all' ? snapshot.repeat : 'none',
      outputDeviceLabel: publicText(snapshot.outputDeviceLabel, 200) || null,
      queueCount: Math.max(0, Math.floor(safeNumber(snapshot.queueLength))),
      currentTrack: currentTrack
        ? dbTrack
          ? this.trackSummary(dbTrack, currentTrack.isFavorite)
          : this.transientTrackSummary(currentTrack, snapshot.duration)
        : null,
      updatedAt
    }
  }

  getQueue(snapshot: MiniPlayerQueueSnapshot | null): CompanionApiQueueSnapshot {
    if (!snapshot || !Array.isArray(snapshot.items)) return { items: [], updatedAt: Date.now() }
    const favoritePaths = new Set(library.getFavoritePaths())
    return {
      items: snapshot.items.slice(0, 5_000).map((item) => {
        const dbTrack = item.trackPath ? library.getTrackByPath(item.trackPath) : null
        const summary = dbTrack
          ? this.trackSummary(dbTrack, favoritePaths.has(dbTrack.path))
          : {
              ref: null,
              title: publicText(item.title),
              artist: publicText(item.artist, 200),
              artists: publicText(item.artist, 200) ? [publicText(item.artist, 200)] : [],
              album: '',
              albumArtists: [],
              durationSeconds: positiveNumber(item.durationSeconds),
              year: null,
              genres: [],
              format: null,
              sampleRateHz: null,
              bitDepth: null,
              channels: null,
              favorite: false,
              artworkUrl: null
            }
        return {
          id: String(item.queueId),
          track: summary,
          current: Boolean(item.isCurrent)
        }
      }),
      updatedAt: safeNumber(snapshot.updatedAt, Date.now())
    }
  }

  search(
    query: string,
    types: ReadonlySet<CompanionApiTargetType>,
    limit: number
  ): CompanionApiSearchResponse {
    const signer = this.options.getSigner()
    const scored: ScoredSearchResult[] = []

    if (types.has('track')) {
      for (const track of library.searchTracks(query)) {
        const score = searchScore(query, [track.title, track.artist, track.album, ...track.artist_names])
        if (score === null) continue
        const ref = signer.create('track', track.id)
        scored.push({
          score,
          result: {
            type: 'track',
            ref,
            title: publicText(track.title),
            subtitle: [publicText(track.artist, 200), publicText(track.album)].filter(Boolean).join(' · ') || null,
            artworkUrl: artworkUrl(ref, Boolean(track.artwork_hash))
          }
        })
      }
    }

    if (types.has('album')) {
      for (const album of library.getAlbums({ includeSingles: true })) {
        const score = searchScore(query, [album.album, album.artist])
        if (score === null) continue
        const ref = signer.create('album', album.identity_key)
        scored.push({
          score,
          result: {
            type: 'album',
            ref,
            title: publicText(album.album),
            subtitle: publicText(album.artist, 200) || null,
            artworkUrl: artworkUrl(ref, Boolean(album.artwork_hash))
          }
        })
      }
    }

    if (types.has('artist')) {
      for (const artist of library.getArtists('canonical')) {
        const score = searchScore(query, [artist.artist])
        if (score === null) continue
        const ref = signer.create('artist', artist.artist)
        scored.push({
          score,
          result: {
            type: 'artist',
            ref,
            title: publicText(artist.artist, 200),
            subtitle: `${artist.album_count} album${artist.album_count === 1 ? '' : 's'}`,
            artworkUrl: artworkUrl(ref, Boolean(artist.artwork_hash))
          }
        })
      }
    }

    if (types.has('playlist')) {
      for (const playlist of library.getPlaylists()) {
        const score = searchScore(query, [playlist.name])
        if (score === null) continue
        const target = library.getCompanionApiPlaylistTarget(playlist.id)
        if (!target) continue
        const ref = signer.create('playlist', playlist.id)
        scored.push({
          score,
          result: {
            type: 'playlist',
            ref,
            title: publicText(playlist.name),
            subtitle: `${playlist.track_count} track${playlist.track_count === 1 ? '' : 's'}`,
            artworkUrl: artworkUrl(ref, Boolean(target.artwork_hash)),
            writable: library.isCompanionApiPlaylistWritable(playlist.id)
          }
        })
      }
    }

    const results = scored
      .sort((left, right) => left.score - right.score || left.result.title.localeCompare(right.result.title))
      .slice(0, limit)
      .map((entry) => entry.result)
    return { query, results, limit }
  }

  resolveTarget(ref: string, expectedType?: CompanionApiTargetType): CompanionApiResolvedTarget | null {
    const parsed = this.options.getSigner().parse(ref, expectedType)
    if (!parsed) return null
    switch (parsed.type) {
      case 'track': {
        const id = parsePositiveIntegerKey(parsed)
        const track = id ? library.getTrackById(id) : null
        if (!track) return null
        return {
          type: 'track',
          ref,
          trackPaths: isPlayableTrack(track) ? [track.path] : [],
          openTarget: { type: 'track', trackPath: track.path }
        }
      }
      case 'album': {
        const album = library.getAlbums({ includeSingles: true }).find((candidate) => candidate.identity_key === parsed.key)
        if (!album) return null
        const tracks = library.getTracksByAlbum(album.album, album.artist, album.identity_key).filter(isPlayableTrack)
        return {
          type: 'album',
          ref,
          trackPaths: tracks.map((track) => track.path),
          openTarget: {
            type: 'album',
            album: album.album,
            artist: album.artist,
            identityKey: album.identity_key
          }
        }
      }
      case 'artist': {
        const artist = library.getArtists('canonical').find((candidate) => candidate.artist === parsed.key)
        if (!artist) return null
        const tracks = library.getTracksByArtist(artist.artist, 'canonical').filter(isPlayableTrack)
        return {
          type: 'artist',
          ref,
          trackPaths: tracks.map((track) => track.path),
          openTarget: { type: 'artist', artist: artist.artist }
        }
      }
      case 'playlist': {
        const id = parsePositiveIntegerKey(parsed)
        const playlist = id ? library.getCompanionApiPlaylistTarget(id) : null
        if (!playlist) return null
        const tracks = library.getPlaylistTracks(playlist.id).filter(isPlayableTrack)
        return {
          type: 'playlist',
          ref,
          trackPaths: tracks.map((track) => track.path),
          openTarget: { type: 'playlist', playlistId: playlist.id }
        }
      }
    }
  }

  async resolveArtworkDataUrl(ref: string): Promise<string | null> {
    const parsed = this.options.getSigner().parse(ref)
    if (!parsed) return null
    let artworkHash: string | null = null
    if (parsed.type === 'track') {
      const id = parsePositiveIntegerKey(parsed)
      artworkHash = id ? library.getTrackById(id)?.artwork_hash ?? null : null
    } else if (parsed.type === 'album') {
      artworkHash = library.getAlbums({ includeSingles: true })
        .find((album) => album.identity_key === parsed.key)?.artwork_hash ?? null
    } else if (parsed.type === 'artist') {
      artworkHash = library.getArtists('canonical')
        .find((artist) => artist.artist === parsed.key)?.artwork_hash ?? null
    } else {
      const id = parsePositiveIntegerKey(parsed)
      artworkHash = id ? library.getCompanionApiPlaylistTarget(id)?.artwork_hash ?? null : null
    }
    return artworkHash ? this.options.resolveArtworkByHash(artworkHash) : null
  }

  async setFavorite(trackRef: string, favorite: boolean): Promise<boolean> {
    const track = this.trackFromRef(trackRef)
    if (!track) return false
    if (favorite) await library.addFavorite(track.path)
    else await library.removeFavorite(track.path)
    this.options.onRendererLibraryMutation()
    this.options.onLibraryEvent({
      kind: 'favorite',
      change: 'favorite-set',
      ref: trackRef,
      favorite,
      updatedAt: Date.now()
    })
    return true
  }

  async createPlaylist(name: string): Promise<{ ref: string; title: string } | null> {
    const playlist = await library.createPlaylist(name)
    const ref = this.options.getSigner().create('playlist', playlist.id)
    this.notifyPlaylist(ref, 'created')
    return { ref, title: playlist.name }
  }

  async renamePlaylist(playlistRef: string, name: string): Promise<boolean> {
    const playlistId = this.writablePlaylistId(playlistRef)
    if (!playlistId) return false
    await library.renamePlaylist(playlistId, name)
    this.notifyPlaylist(playlistRef, 'renamed')
    return true
  }

  async addPlaylistItems(playlistRef: string, trackRefs: string[]): Promise<boolean> {
    const playlistId = this.writablePlaylistId(playlistRef)
    if (!playlistId) return false
    const tracks = trackRefs.map((ref) => this.trackFromRef(ref))
    if (tracks.some((track) => !track)) return false
    await library.addToPlaylist(playlistId, tracks.map((track) => track!.path))
    this.notifyPlaylist(playlistRef, 'items-changed')
    return true
  }

  async removePlaylistItem(playlistRef: string, trackRef: string): Promise<boolean> {
    const playlistId = this.writablePlaylistId(playlistRef)
    const track = this.trackFromRef(trackRef)
    if (!playlistId || !track) return false
    await library.removeFromPlaylist(playlistId, track.path)
    this.notifyPlaylist(playlistRef, 'items-changed')
    return true
  }

  async movePlaylistItem(playlistRef: string, trackRef: string, position: number): Promise<boolean> {
    const playlistId = this.writablePlaylistId(playlistRef)
    const track = this.trackFromRef(trackRef)
    if (!playlistId || !track) return false
    const updated = await library.moveCompanionApiPlaylistTrack(playlistId, track.path, position)
    if (updated) this.notifyPlaylist(playlistRef, 'items-changed')
    return updated
  }

  private trackSummary(track: library.DbTrack, favorite: boolean): CompanionApiTrackSummary {
    const ref = this.options.getSigner().create('track', track.id)
    const artists = normalizeNames(track.artist_names, track.artist)
    const albumArtists = normalizeNames(track.album_artist_names, track.album_artist)
    return {
      ref,
      title: publicText(track.title),
      artist: displayName(artists, track.artist),
      artists,
      album: publicText(track.album),
      albumArtists,
      durationSeconds: positiveNumber(track.duration),
      year: safeInteger(track.year),
      genres: publicTextList(track.genres, 32, 100),
      format: publicText(track.format, 50) || null,
      sampleRateHz: safeInteger(track.sample_rate),
      bitDepth: safeInteger(track.bit_depth),
      channels: safeInteger(track.channels),
      favorite,
      artworkUrl: artworkUrl(ref, Boolean(track.artwork_hash))
    }
  }

  private transientTrackSummary(
    track: NonNullable<MiniPlayerSnapshot['currentTrack']>,
    duration: number
  ): CompanionApiTrackSummary {
    const artists = normalizeNames(track.artistNames, track.artist)
    const albumArtists = normalizeNames(track.albumArtistNames, track.albumArtist)
    return {
      ref: null,
      title: publicText(track.title),
      artist: displayName(artists, track.artist),
      artists,
      album: publicText(track.album),
      albumArtists,
      durationSeconds: positiveNumber(track.duration) ?? positiveNumber(duration),
      year: safeInteger(track.year),
      genres: publicTextList(track.genres, 32, 100),
      format: publicText(track.format, 50) || null,
      sampleRateHz: safeInteger(track.sampleRate),
      bitDepth: safeInteger(track.bitDepth),
      channels: safeInteger(track.channels),
      favorite: Boolean(track.isFavorite),
      artworkUrl: null
    }
  }

  private trackFromRef(ref: string): library.DbTrack | null {
    const parsed = this.options.getSigner().parse(ref, 'track')
    if (!parsed) return null
    const id = parsePositiveIntegerKey(parsed)
    return id ? library.getTrackById(id) : null
  }

  private writablePlaylistId(ref: string): number | null {
    const parsed = this.options.getSigner().parse(ref, 'playlist')
    if (!parsed) return null
    const id = parsePositiveIntegerKey(parsed)
    return id && library.isCompanionApiPlaylistWritable(id) ? id : null
  }

  private notifyPlaylist(
    ref: string,
    change: Extract<CompanionApiLibraryEvent['change'], 'created' | 'renamed' | 'items-changed'>
  ): void {
    this.options.onRendererLibraryMutation()
    this.options.onLibraryEvent({ kind: 'playlist', change, ref, updatedAt: Date.now() })
  }
}
