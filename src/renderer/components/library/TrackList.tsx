import { usePlayerStore } from '../../stores/playerStore'
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
              {hasQueue && (
                <div className="track-actions">
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
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
