import { useEffect, useMemo, useState } from 'react'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import AlbumArtwork from '../library/AlbumArtwork'

type CueVisibility = 'hidden' | 'visible'

const ASSOCIATED_OPEN_CUE_HIDE_MS = 4200
const ASSOCIATED_OPEN_CUE_CLEAR_MS = 4600

export default function AssociatedOpenCue() {
  const notice = usePlayerStore((s) => s.associatedOpenNotice)
  const clearNotice = usePlayerStore((s) => s.clearAssociatedOpenNotice)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const isFullscreen = useUIStore((s) => s.isFullscreen)
  const [visibility, setVisibility] = useState<CueVisibility>('hidden')

  useEffect(() => {
    if (!notice) {
      setVisibility('hidden')
      return
    }

    setVisibility('visible')
    const hideTimer = window.setTimeout(() => setVisibility('hidden'), ASSOCIATED_OPEN_CUE_HIDE_MS)
    const clearTimer = window.setTimeout(() => clearNotice(), ASSOCIATED_OPEN_CUE_CLEAR_MS)

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

  const countLabel = notice.fileCount === 1 ? '1 file' : `${notice.fileCount} files`
  const activeTitle = artworkTrack?.title?.trim() || notice.title
  const subtitleLine = notice.fileCount > 1
    ? `${activeTitle} • ${notice.fileCount - 1} more queued`
    : `${activeTitle} • ready to play`

  return (
    <aside
      className={`associated-open-cue associated-open-cue-${visibility}${isFullscreen ? ' associated-open-cue-fullscreen' : ''}`}
      aria-live="polite"
      aria-hidden={visibility === 'hidden'}
    >
      <div className="fullscreen-next-cue-card">
        <div className="fullscreen-next-cue-artwork">
          {artworkTrack?.artworkHash ? (
            <AlbumArtwork hash={artworkTrack.artworkHash} alt="Open with Astra cue artwork" variant="card" />
          ) : artworkTrack?.artworkData ? (
            <img src={artworkTrack.artworkData} alt="Open with Astra cue artwork" />
          ) : (
            <div className="fullscreen-next-cue-placeholder">OA</div>
          )}
        </div>

        <div className="fullscreen-next-cue-meta">
          <span className="fullscreen-next-cue-label">Open With Astra</span>
          <div className="fullscreen-next-cue-title">Playing from {notice.sourceLabel}</div>
          <div className="fullscreen-next-cue-artist">{subtitleLine}</div>
        </div>

        <div className="associated-open-cue-badge">{countLabel}</div>
      </div>

      <div className="fullscreen-next-cue-progress">
        <div key={notice.id} className="fullscreen-next-cue-fill associated-open-cue-fill" />
      </div>
    </aside>
  )
}
