import { useState } from 'react'
import { usePlayerStore } from '../../stores/playerStore'
import { useLibraryStore } from '../../stores/libraryStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { Track } from '../../types/audio'

interface DbTrack {
  id: number
  path: string
  title: string
  artist: string
  album: string
  duration: number
  track_number: number | null
  artwork_hash: string | null
  format: string
  sample_rate: number | null
  bit_depth: number | null
  bitrate: number | null
}

interface TrackListProps {
  tracks: DbTrack[]
  showArtist?: boolean
  showAlbum?: boolean
}

// Convert DbTrack to Track
function dbTrackToTrack(dbTrack: DbTrack): Track {
  return {
    id: dbTrack.path,
    path: dbTrack.path,
    title: dbTrack.title,
    artist: dbTrack.artist,
    album: dbTrack.album,
    duration: dbTrack.duration,
    format: dbTrack.format,
    artworkHash: dbTrack.artwork_hash ?? undefined,
    sampleRate: dbTrack.sample_rate ?? undefined,
    bitDepth: dbTrack.bit_depth ?? undefined,
    bitrate: dbTrack.bitrate ?? undefined
  }
}

export default function TrackList({ tracks, showArtist = true, showAlbum = true }: TrackListProps) {
  const { currentTrack, playbackState, loadTrack, play, setQueue, addToQueue, addToQueueNext, queue } = usePlayerStore()
  const favorites = useLibraryStore((s) => s.favorites)
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite)
  const { playlists, addToPlaylist } = usePlaylistStore()

  const [playlistDropdownTrack, setPlaylistDropdownTrack] = useState<string | null>(null)

  const formatDuration = (seconds: number): string => {
    if (!seconds || !isFinite(seconds)) return '--:--'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const handleTrackClick = async (dbTrack: DbTrack, index: number) => {
    // Convert all tracks to Track format and set queue
    const queueTracks = tracks.map(dbTrackToTrack)
    setQueue(queueTracks, index)

    // Load the audio file
    const result = await window.electronAPI.loadAudioFile(dbTrack.path)
    if (result) {
      const track: Track = {
        id: dbTrack.path,
        path: dbTrack.path,
        title: result.metadata?.title ?? dbTrack.title,
        artist: result.metadata?.artist ?? dbTrack.artist,
        album: result.metadata?.album ?? dbTrack.album,
        duration: result.metadata?.duration ?? dbTrack.duration,
        format: dbTrack.format,
        artworkData: result.metadata?.artwork,
        artworkHash: dbTrack.artwork_hash ?? undefined,
        sampleRate: dbTrack.sample_rate ?? undefined,
        bitDepth: dbTrack.bit_depth ?? undefined,
        bitrate: dbTrack.bitrate ?? undefined
      }
      await loadTrack(track, result.data)
      await play()
    }
  }

  const handlePlayNext = (e: React.MouseEvent, dbTrack: DbTrack) => {
    e.stopPropagation()
    addToQueueNext(dbTrackToTrack(dbTrack))
  }

  const handleAddToQueue = (e: React.MouseEvent, dbTrack: DbTrack) => {
    e.stopPropagation()
    addToQueue(dbTrackToTrack(dbTrack))
  }

  const isCurrentTrack = (track: DbTrack) => currentTrack?.path === track.path
  const isPlaying = playbackState === 'playing'
  const hasQueue = queue.length > 0

  if (tracks.length === 0) {
    return (
      <div className="track-list-empty">
        <p>No tracks found</p>
      </div>
    )
  }

  return (
    <div className="track-list">
      <div className="track-list-header">
        <div className="track-col track-col-num">#</div>
        <div className="track-col track-col-title">Title</div>
        {showArtist && <div className="track-col track-col-artist">Artist</div>}
        {showAlbum && <div className="track-col track-col-album">Album</div>}
        <div className="track-col track-col-duration">Duration</div>
        <div className="track-col track-col-actions" />
      </div>
      <div className="track-list-body">
        {tracks.map((track, index) => (
          <div
            key={track.id}
            className={`track-row ${isCurrentTrack(track) ? 'track-row-active' : ''}`}
            onClick={() => handleTrackClick(track, index)}
          >
            <div className="track-col track-col-num">
              {isCurrentTrack(track) && isPlaying ? (
                <span className="track-playing-icon">&#9654;</span>
              ) : (
                <span className="track-number">{track.track_number ?? index + 1}</span>
              )}
            </div>
            <div className="track-col track-col-title">
              <span className="track-title">{track.title}</span>
            </div>
            {showArtist && (
              <div className="track-col track-col-artist">
                <span className="track-artist">{track.artist}</span>
              </div>
            )}
            {showAlbum && (
              <div className="track-col track-col-album">
                <span className="track-album">{track.album}</span>
              </div>
            )}
            <div className="track-col track-col-duration">
              <span className="track-duration">{formatDuration(track.duration)}</span>
            </div>
            <div className="track-col track-col-actions">
              <div className="track-actions">
                <button
                  className={`track-action-btn ${favorites.has(track.path) ? 'active' : ''}`}
                  onClick={(e) => { e.stopPropagation(); toggleFavorite(track.path) }}
                  title={favorites.has(track.path) ? 'Remove from favorites' : 'Add to favorites'}
                >
                  {favorites.has(track.path) ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                    </svg>
                  )}
                </button>
                <div className="track-playlist-wrap">
                  <button
                    className="track-action-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPlaylistDropdownTrack(playlistDropdownTrack === track.path ? null : track.path)
                    }}
                    title="Add to playlist"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
                    </svg>
                  </button>
                  {playlistDropdownTrack === track.path && (
                    <div className="track-playlist-dropdown" onClick={(e) => e.stopPropagation()}>
                      {playlists.length > 0 ? (
                        playlists.map((pl) => (
                          <button
                            key={pl.id}
                            className="track-playlist-option"
                            onClick={async (e) => {
                              e.stopPropagation()
                              await addToPlaylist(pl.id, [track.path])
                              setPlaylistDropdownTrack(null)
                            }}
                          >
                            {pl.name}
                          </button>
                        ))
                      ) : (
                        <div className="track-playlist-empty">No playlists</div>
                      )}
                    </div>
                  )}
                </div>
                {hasQueue && (
                  <>
                    <button
                      className="track-action-btn"
                      onClick={(e) => handlePlayNext(e, track)}
                      title="Play Next"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
                      </svg>
                    </button>
                    <button
                      className="track-action-btn"
                      onClick={(e) => handleAddToQueue(e, track)}
                      title="Add to Queue"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M13 7h-2v4H7v2h4v4h2v-4h4v-2h-4V7zm-1-5C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/>
                      </svg>
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
