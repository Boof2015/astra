import { useEffect, useMemo, useState } from 'react'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import AlbumArtwork from '../library/AlbumArtwork'

type CueVisibility = 'hidden' | 'visible'

export default function DecodeFallbackCue() {
  const notice = usePlayerStore((s) => s.ffmpegFallbackNotice)
  const clearNotice = usePlayerStore((s) => s.clearFfmpegFallbackNotice)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const isFullscreen = useUIStore((s) => s.isFullscreen)
  const [visibility, setVisibility] = useState<CueVisibility>('hidden')

  useEffect(() => {
    if (!notice) {
      setVisibility('hidden')
      return
    }

    setVisibility('visible')
    const hideTimer = window.setTimeout(() => setVisibility('hidden'), 5200)
    const clearTimer = window.setTimeout(() => clearNotice(), 5600)

    return () => {
      window.clearTimeout(hideTimer)
      window.clearTimeout(clearTimer)
    }
  }, [notice, clearNotice])

  const artworkTrack = useMemo(() => {
    if (!notice) return null
    if (!currentTrack) return null
    return currentTrack.path === notice.trackPath ? currentTrack : null
  }, [currentTrack, notice])

  if (!notice) {
    return null
  }

  const artistLine = notice.artist && notice.artist.trim().length > 0 ? notice.artist : 'Unknown Artist'
  const titleLine = notice.title && notice.title.trim().length > 0 ? notice.title : 'Unknown Track'

  return (
    <aside
      className={`decode-fallback-cue decode-fallback-cue-${visibility}${isFullscreen ? ' decode-fallback-cue-fullscreen' : ''}`}
      aria-live="polite"
      aria-hidden={visibility === 'hidden'}
    >
      <div className="fullscreen-next-cue-card">
        <div className="fullscreen-next-cue-artwork">
          {artworkTrack?.artworkHash ? (
            <AlbumArtwork hash={artworkTrack.artworkHash} alt="Fallback decode artwork" variant="card" />
          ) : artworkTrack?.artworkData ? (
            <img src={artworkTrack.artworkData} alt="Fallback decode artwork" />
          ) : (
            <div className="fullscreen-next-cue-placeholder">FF</div>
          )}
        </div>

        <div className="fullscreen-next-cue-meta">
          <span className="fullscreen-next-cue-label">Decode Fallback</span>
          <div className="fullscreen-next-cue-title">Using FFmpeg compatibility decoding</div>
          <div className="fullscreen-next-cue-artist">{titleLine} • {artistLine}</div>
        </div>

        <div className="decode-fallback-cue-badge">FFmpeg</div>
      </div>

      <div className="fullscreen-next-cue-progress">
        <div key={notice.id} className="fullscreen-next-cue-fill decode-fallback-cue-fill" />
      </div>
    </aside>
  )
}
