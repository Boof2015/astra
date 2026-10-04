import { useEffect, useState } from 'react'
import { REMOTE_CACHE_MAX_GB, REMOTE_CACHE_MIN_GB, type RemoteAudioCacheStatus } from '../../../types/remoteAudioCache'

export default function RemoteAudioCacheSettings() {
  const [status, setStatus] = useState<RemoteAudioCacheStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    const refresh = () => {
      void window.electronAPI.getRemoteCacheStatus().then(value => {
        if (active) setStatus(value)
      }).catch(() => { if (active) setError('Could not read remote cache usage.') })
    }
    refresh()
    const timer = window.setInterval(refresh, 5_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  const update = async (work: () => Promise<RemoteAudioCacheStatus>) => {
    setBusy(true)
    setError(null)
    try { setStatus(await work()) }
    catch { setError('Could not update the remote cache. Please try again.') }
    finally { setBusy(false) }
  }

  return (
    <section className="settings-card">
      <h4 className="settings-card-label">Remote audio cache</h4>
      <p className="settings-note">Keep recently played audio for faster replay. Currently available for Subsonic and Navidrome.</p>
      <label className="settings-field">
        <span className="settings-field-label">Cache limit</span>
        <select
          className="settings-select"
          value={status?.limitGb ?? 5}
          disabled={busy || !status}
          onChange={event => { void update(() => window.electronAPI.setRemoteCacheLimit(Number(event.target.value))) }}
        >
          {Array.from({ length: REMOTE_CACHE_MAX_GB - REMOTE_CACHE_MIN_GB + 1 }, (_, index) => index + REMOTE_CACHE_MIN_GB).map(gb => (
            <option key={gb} value={gb}>{gb} GB{gb === 5 ? ' (default)' : ''}</option>
          ))}
        </select>
      </label>
      <div className="settings-field settings-field-inline">
        <span className="settings-field-label">{status ? `${(status.usedBytes / 1024 ** 3).toFixed(2)} GB used` : 'Reading cache usage…'}</span>
        <button className="settings-btn" disabled={busy || !status} onClick={() => { void update(() => window.electronAPI.clearRemoteCache()) }}>
          Clear cache
        </button>
      </div>
      <p className="settings-note">Audio in use stays cached. The oldest unused audio is removed when space is needed.</p>
      {error && <p className="settings-note settings-note-error" role="alert">{error}</p>}
    </section>
  )
}
