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
    format: dbTrack.format
  }
}

export default function TrackList({ tracks, showArtist = true, showAlbum = true }: TrackListProps) {
  const { currentTrack, playbackState, loadTrack, setQueue } = usePlayerStore()

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
        artworkData: result.metadata?.artwork
      }
      await loadTrack(track, result.data)
    }
  }

  const isCurrentTrack = (track: DbTrack) => currentTrack?.path === track.path
  const isPlaying = playbackState === 'playing'

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
                <span className="track-playing-icon">▶</span>
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
          </div>
        ))}
      </div>
    </div>
  )
}
