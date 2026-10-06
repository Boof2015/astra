import { useEffect } from 'react'
import { useProviderSyncStore } from '../../stores/providerSyncStore'

export default function ProviderSyncNotice() {
  const { notice, dismissNotice, openReview, working } = useProviderSyncStore()
  useEffect(() => {
    if (!notice || notice.ref) return
    const timer = setTimeout(dismissNotice, 6500)
    return () => clearTimeout(timer)
  }, [notice, dismissNotice])
  if (!notice) return null
  return <aside className="decode-fallback-cue decode-fallback-cue-visible provider-sync-notice" aria-live="polite">
    <div className="fullscreen-next-cue-card"><div className="fullscreen-next-cue-meta">
      <span className="fullscreen-next-cue-label">Server sync</span><div>{notice.message}</div>
      <div className="provider-sync-actions">{notice.ref && <button className="settings-btn" disabled={working} onClick={() => void openReview(notice.ref!)}>Review</button>}
        <button className="settings-btn" onClick={dismissNotice}>Dismiss</button></div>
    </div></div>
  </aside>
}
