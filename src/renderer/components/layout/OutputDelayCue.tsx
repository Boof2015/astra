import { useEffect, useMemo, useState } from 'react'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import AlbumArtwork from '../library/AlbumArtwork'

type CueVisibility = 'hidden' | 'visible'

const MIN_CUE_DURATION_MS = 3800
const MAX_CUE_DURATION_MS = 6200

function resolveCueDuration(delayMs: number): number {
  return Math.max(MIN_CUE_DURATION_MS, Math.min(MAX_CUE_DURATION_MS, delayMs + 3200))
}

export default function OutputDelayCue() {
  const notice = usePlayerStore((s) => s.outputDelayNotice)
  const clearNotice = usePlayerStore((s) => s.clearOutputDelayNotice)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const isFullscreen = useUIStore((s) => s.isFullscreen)
  const [visibility, setVisibility] = useState<CueVisibility>('hidden')

  useEffect(() => {
    if (!notice) {
      setVisibility('hidden')
      return
    }

    const cueDurationMs = resolveCueDuration(notice.delayMs)
    setVisibility('visible')

    const hideTimer = window.setTimeout(() => setVisibility('hidden'), cueDurationMs - 360)
    const clearTimer = window.setTimeout(() => clearNotice(), cueDurationMs)

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

  const cueDurationMs = resolveCueDuration(notice.delayMs)
  const outputLabel = notice.outputLabel && notice.outputLabel.trim().length > 0
    ? notice.outputLabel
    : 'System Default Output'
  const titleLine = notice.title && notice.title.trim().length > 0 ? notice.title : 'Unknown Track'
  const artistLine = notice.artist && notice.artist.trim().length > 0 ? notice.artist : 'Unknown Artist'

  return (
    <aside
      className={`output-delay-cue output-delay-cue-${visibility}${isFullscreen ? ' output-delay-cue-fullscreen' : ''}`}
      aria-live="polite"
      aria-hidden={visibility === 'hidden'}
    >
      <div className="fullscreen-next-cue-card">
        <div className="fullscreen-next-cue-artwork">
          {artworkTrack?.artworkHash ? (
            <AlbumArtwork hash={artworkTrack.artworkHash} alt="Output delay cue artwork" variant="card" />
          ) : artworkTrack?.artworkData ? (
            <img src={artworkTrack.artworkData} alt="Output delay cue artwork" />
          ) : (
            <div className="fullscreen-next-cue-placeholder">DL</div>
          )}
        </div>

        <div className="fullscreen-next-cue-meta">
          <span className="fullscreen-next-cue-label">Output Delay</span>
          <div className="fullscreen-next-cue-title">Delay compensation active ({notice.delayMs} ms)</div>
          <div className="fullscreen-next-cue-artist">{titleLine} • {artistLine}</div>
          <div className="fullscreen-next-cue-artist">{outputLabel} • heard playback starts shortly</div>
        </div>

        <div className="output-delay-cue-badge">{notice.delayMs}ms</div>
      </div>

      <div className="fullscreen-next-cue-progress">
        <div
          key={notice.id}
          className="fullscreen-next-cue-fill output-delay-cue-fill"
          style={{ animationDuration: `${cueDurationMs}ms` }}
        />
      </div>
    </aside>
  )
}
