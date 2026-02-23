import { useEffect, useState } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { useUpdateStore } from '../../stores/updateStore'
import AstraLogo from '../icons/AstraLogo'

type CueVisibility = 'hidden' | 'visible'

const UPDATE_CUE_HIDE_MS = 5200
const UPDATE_CUE_CLEAR_MS = 5600

export default function UpdateAvailableCue() {
  const notice = useUpdateStore((s) => s.cueNotice)
  const clearCueNotice = useUpdateStore((s) => s.clearCueNotice)
  const openReleasesPage = useUpdateStore((s) => s.openReleasesPage)
  const isFullscreen = useUIStore((s) => s.isFullscreen)
  const [visibility, setVisibility] = useState<CueVisibility>('hidden')

  useEffect(() => {
    if (!notice) {
      setVisibility('hidden')
      return
    }

    setVisibility('visible')
    const hideTimer = window.setTimeout(() => setVisibility('hidden'), UPDATE_CUE_HIDE_MS)
    const clearTimer = window.setTimeout(() => clearCueNotice(), UPDATE_CUE_CLEAR_MS)

    return () => {
      window.clearTimeout(hideTimer)
      window.clearTimeout(clearTimer)
    }
  }, [notice, clearCueNotice])

  if (!notice) {
    return null
  }

  const releaseSummary = notice.releaseName?.trim().length
    ? notice.releaseName
    : `Current version v${notice.currentVersion}`
  const handleOpenDownload = () => {
    void openReleasesPage(notice.releaseUrl)
    clearCueNotice()
  }

  return (
    <aside
      className={`update-available-cue update-available-cue-${visibility}${isFullscreen ? ' update-available-cue-fullscreen' : ''}`}
      aria-live="polite"
      aria-hidden={visibility === 'hidden'}
    >
      <div className="fullscreen-next-cue-card">
        <div className="fullscreen-next-cue-artwork update-available-cue-artwork" aria-hidden="true">
          <AstraLogo size={52} includeBackground className="update-available-cue-icon" />
        </div>

        <div className="fullscreen-next-cue-meta">
          <span className="fullscreen-next-cue-label">Update Available</span>
          <div className="fullscreen-next-cue-title">{notice.latestTag} is ready to download</div>
          <div className="fullscreen-next-cue-artist">{releaseSummary}</div>
        </div>

        <button
          type="button"
          className="update-available-cue-badge"
          onClick={handleOpenDownload}
          aria-label={`Download update ${notice.latestTag}`}
          title={`Download ${notice.latestTag}`}
        >
          Download
        </button>
      </div>

      <div className="fullscreen-next-cue-progress">
        <div key={notice.id} className="fullscreen-next-cue-fill update-available-cue-fill" />
      </div>
    </aside>
  )
}
