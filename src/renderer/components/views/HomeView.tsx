import { useMemo } from 'react'
import { useLibraryStore } from '../../stores/libraryStore'
import { usePlayerStore } from '../../stores/playerStore'
import AlbumArtwork from '../library/AlbumArtwork'

interface HomeTrack {
  path: string
  title: string
  artist: string
  album: string
  duration: number
  format: string
  artwork_hash: string | null
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
  const currentTrackPath = usePlayerStore((s) => s.currentTrack?.path ?? null)

  const recentTracks = useMemo(() => tracks.slice(0, 8), [tracks])
  const favoriteTracks = useMemo(() => tracks.slice(0, 10), [tracks])
  const artistPreview = useMemo(() => artists.slice(0, 8), [artists])
  const albumPreview = useMemo(() => albums.slice(0, 12), [albums])

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
              {recentTracks.map((track) => (
                <article
                  key={track.path}
                  className={`home-track-card ${currentTrackPath === track.path ? 'active' : ''}`}
                >
                  <div className="home-track-artwork">
                    {track.artwork_hash ? (
                      <AlbumArtwork hash={track.artwork_hash} alt={track.album} />
                    ) : (
                      <span>♫</span>
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
            <div className="home-empty-strip">No recent tracks yet.</div>
          )}
        </section>

        <section className="home-section">
          <div className="home-section-header">
            <h2>FAVORITES</h2>
          </div>
          {favoriteTracks.length > 0 ? (
            <div className="home-favorites-list">
              {favoriteTracks.map((track) => (
                <div
                  key={`${track.path}-favorite`}
                  className={`home-favorite-row ${currentTrackPath === track.path ? 'active' : ''}`}
                >
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
            <div className="home-empty-strip">No tracks available.</div>
          )}
        </section>

        <section className="home-section">
          <div className="home-section-header">
            <h2>ARTISTS</h2>
          </div>
          {artistPreview.length > 0 ? (
            <div className="home-artist-row">
              {artistPreview.map((artist) => (
                <div key={artist.artist} className="home-artist-chip">
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
                <article key={`${album.album}-${album.artist}`} className="home-album-card">
                  <div className="home-album-artwork">
                    {album.artwork_hash ? (
                      <AlbumArtwork hash={album.artwork_hash} alt={album.album} />
                    ) : (
                      <span>♫</span>
                    )}
                  </div>
                  <div className="home-album-title">{album.album}</div>
                  <div className="home-album-artist">{album.artist}</div>
                  <div className="home-album-meta">
                    {album.track_count} tracks
                    {album.year ? ` · ${album.year}` : ''}
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
          </div>
          <div className="home-playlists-placeholder">
            <div className="home-playlists-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            </div>
            <p>PLAYLISTS COMING SOON</p>
            <span>Create and manage custom playlists from your library.</span>
          </div>
        </section>
      </div>
    </div>
  )
}
