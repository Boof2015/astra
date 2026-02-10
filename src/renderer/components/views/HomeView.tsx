import { useEffect, useMemo, useState } from 'react'
import { useLibraryStore } from '../../stores/libraryStore'
import { usePlayerStore } from '../../stores/playerStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useUIStore } from '../../stores/uiStore'
import { Track } from '../../types/audio'
import AlbumArtwork from '../library/AlbumArtwork'

interface HomeTrack {
  path: string
  title: string
  artist: string
  album: string
  duration: number
  format: string
  artwork_hash: string | null
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
}

interface HomeAlbum {
  album: string
  artist: string
  year: number | null
  artwork_hash: string | null
  track_count: number
}

interface HomeArtist {
  artist: string
  track_count: number
}

function formatDuration(seconds: number): string {
  if (!seconds || !isFinite(seconds)) return '--:--'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function artistInitial(artist: string): string {
  return artist.trim().charAt(0).toUpperCase() || '?'
}

export default function HomeView() {
  const tracks = useLibraryStore((s) => s.tracks as HomeTrack[])
  const albums = useLibraryStore((s) => s.albums as HomeAlbum[])
  const artists = useLibraryStore((s) => s.artists as HomeArtist[])
  const recentlyPlayed = useLibraryStore((s) => s.recentlyPlayed as HomeTrack[])
  const favoriteTracks = useLibraryStore((s) => s.favoriteTracks as HomeTrack[])
  const setLibraryViewMode = useLibraryStore((s) => s.setViewMode)
  const selectAlbum = useLibraryStore((s) => s.selectAlbum)
  const selectArtist = useLibraryStore((s) => s.selectArtist)
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite)
  const currentTrackPath = usePlayerStore((s) => s.currentTrack?.path ?? null)
  const { loadTrack, play, setQueue } = usePlayerStore()
  const { playlists, loadPlaylists, createPlaylist } = usePlaylistStore()
  const { setActiveView } = useUIStore()
  const selectPlaylist = usePlaylistStore((s) => s.selectPlaylist)

  const [showCreateInput, setShowCreateInput] = useState(false)
  const [newPlaylistName, setNewPlaylistName] = useState('')

  useEffect(() => {
    loadPlaylists()
  }, [loadPlaylists])

  const recentTracks = useMemo(() => recentlyPlayed.slice(0, 8), [recentlyPlayed])
  const favoritePreview = useMemo(() => favoriteTracks.slice(0, 10), [favoriteTracks])
  const artistPreview = useMemo(() => artists.slice(0, 8), [artists])
  const albumPreview = useMemo(() => albums.slice(0, 12), [albums])

  const handlePlayTrack = async (track: HomeTrack) => {
    const result = await window.electronAPI.loadAudioFile(track.path)
    if (result) {
      const t: Track = {
        id: track.path,
        path: track.path,
        title: result.metadata?.title ?? track.title,
        artist: result.metadata?.artist ?? track.artist,
        album: result.metadata?.album ?? track.album,
        duration: result.metadata?.duration ?? track.duration,
        format: track.format,
        artworkData: result.metadata?.artwork,
        artworkHash: track.artwork_hash ?? undefined,
        sampleRate: track.sample_rate ?? undefined,
        bitDepth: track.bit_depth ?? undefined,
        bitrate: track.bitrate ?? undefined
      }
      await loadTrack(t, result.data)
      await play()
    }
  }

  const handlePlayRecentList = async (track: HomeTrack, index: number) => {
    // Set queue from recent tracks and play selected
    const queueTracks: Track[] = recentTracks.map((t) => ({
      id: t.path,
      path: t.path,
      title: t.title,
      artist: t.artist,
      album: t.album,
      duration: t.duration,
      format: t.format,
      artworkHash: t.artwork_hash ?? undefined,
      sampleRate: t.sample_rate ?? undefined,
      bitDepth: t.bit_depth ?? undefined,
      bitrate: t.bitrate ?? undefined
    }))
    setQueue(queueTracks, index)
    await handlePlayTrack(track)
  }

  const handleCreatePlaylist = async () => {
    const name = newPlaylistName.trim()
    if (!name) return
    await createPlaylist(name)
    setNewPlaylistName('')
    setShowCreateInput(false)
  }

  const handleOpenPlaylist = async (playlistId: number) => {
    await selectPlaylist(playlistId)
    setActiveView('playlist')
  }

  const handleOpenArtist = async (artistName: string) => {
    setLibraryViewMode('artists')
    await selectArtist(artistName, 'home')
    setActiveView('library')
  }

  const handleOpenAlbum = async (album: HomeAlbum) => {
    setLibraryViewMode('albums')
    await selectAlbum(album.album, album.artist, 'home')
    setActiveView('library')
  }

  if (tracks.length === 0 && albums.length === 0 && artists.length === 0) {
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
      <div className="home-content">
        <section className="home-section">
          <div className="home-section-header">
            <h2>RECENTLY PLAYED</h2>
          </div>
          {recentTracks.length > 0 ? (
            <div className="home-recent-row">
              {recentTracks.map((track, i) => (
                <article
                  key={`${track.path}-${i}`}
                  className={`home-track-card ${currentTrackPath === track.path ? 'active' : ''}`}
                  onClick={() => handlePlayRecentList(track, i)}
                >
                  <div className="home-track-artwork">
                    {track.artwork_hash ? (
                      <AlbumArtwork hash={track.artwork_hash} alt={track.album} />
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

        <section className="home-section">
          <div className="home-section-header">
            <h2>FAVORITES</h2>
          </div>
          {favoritePreview.length > 0 ? (
            <div className="home-favorites-list">
              {favoritePreview.map((track) => (
                <div
                  key={`${track.path}-favorite`}
                  className={`home-favorite-row ${currentTrackPath === track.path ? 'active' : ''}`}
                  onClick={() => handlePlayTrack(track)}
                >
                  <button
                    className="home-favorite-heart active"
                    onClick={(e) => { e.stopPropagation(); toggleFavorite(track.path) }}
                    title="Remove from favorites"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                    </svg>
                  </button>
                  <div className="home-favorite-main">
                    <div className="home-favorite-title">{track.title}</div>
                    <div className="home-favorite-artist">{track.artist}</div>
                  </div>
                  <div className="home-favorite-meta">
                    <span>{track.format.toUpperCase()}</span>
                    <span>{formatDuration(track.duration)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="home-empty-strip">No favorites yet. Click the heart icon on a track to add it.</div>
          )}
        </section>

        <section className="home-section">
          <div className="home-section-header">
            <h2>ARTISTS</h2>
          </div>
          {artistPreview.length > 0 ? (
            <div className="home-artist-row">
              {artistPreview.map((artist) => (
                <div
                  key={artist.artist}
                  className="home-artist-chip"
                  onClick={() => handleOpenArtist(artist.artist)}
                >
                  <div className="home-artist-avatar">{artistInitial(artist.artist)}</div>
                  <div className="home-artist-name">{artist.artist}</div>
                  <div className="home-artist-count">{artist.track_count} tracks</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="home-empty-strip">No artists found.</div>
          )}
        </section>

        <section className="home-section">
          <div className="home-section-header">
            <h2>ALBUMS</h2>
          </div>
          {albumPreview.length > 0 ? (
            <div className="home-album-grid">
              {albumPreview.map((album) => (
                <article
                  key={`${album.album}-${album.artist}`}
                  className="home-album-card"
                  onClick={() => handleOpenAlbum(album)}
                >
                  <div className="home-album-artwork">
                    {album.artwork_hash ? (
                      <AlbumArtwork hash={album.artwork_hash} alt={album.album} />
                    ) : (
                      <span>&#9835;</span>
                    )}
                  </div>
                  <div className="home-album-title">{album.album}</div>
                  <div className="home-album-artist">{album.artist}</div>
                  <div className="home-album-meta">
                    {album.track_count} tracks
                    {album.year ? ` \u00b7 ${album.year}` : ''}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="home-empty-strip">No albums found.</div>
          )}
        </section>

        <section className="home-section">
          <div className="home-section-header">
            <h2>PLAYLISTS</h2>
            <button
              className="home-create-playlist-btn"
              onClick={() => setShowCreateInput(!showCreateInput)}
              title="Create playlist"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
          {showCreateInput && (
            <div className="home-create-playlist-form">
              <input
                type="text"
                className="home-create-playlist-input"
                placeholder="Playlist name..."
                value={newPlaylistName}
                onChange={(e) => setNewPlaylistName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreatePlaylist(); if (e.key === 'Escape') setShowCreateInput(false) }}
                autoFocus
              />
              <button className="home-create-playlist-confirm" onClick={handleCreatePlaylist}>
                Create
              </button>
            </div>
          )}
          {playlists.length > 0 ? (
            <div className="home-playlist-grid">
              {playlists.map((playlist) => (
                <div
                  key={playlist.id}
                  className="home-playlist-card"
                  onClick={() => handleOpenPlaylist(playlist.id)}
                >
                  <div className="home-playlist-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="8" y1="6" x2="21" y2="6" />
                      <line x1="8" y1="12" x2="21" y2="12" />
                      <line x1="8" y1="18" x2="21" y2="18" />
                      <line x1="3" y1="6" x2="3.01" y2="6" />
                      <line x1="3" y1="12" x2="3.01" y2="12" />
                      <line x1="3" y1="18" x2="3.01" y2="18" />
                    </svg>
                  </div>
                  <div className="home-playlist-name">{playlist.name}</div>
                  <div className="home-playlist-count">{playlist.track_count} tracks</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="home-empty-strip">
              {showCreateInput ? '' : 'No playlists yet. Click + to create one.'}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
