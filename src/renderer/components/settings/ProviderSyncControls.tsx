import { useProviderSyncStore } from '../../stores/providerSyncStore'
import type { ProviderSyncRef } from '../../../types/providerSync'

export default function ProviderSyncControls({ provider, sourceId, connected }: ProviderSyncRef & { connected: boolean }) {
  const status = useProviderSyncStore(s => s.statuses.find(item => item.provider === provider && item.sourceId === sourceId))
  const working = useProviderSyncStore(s => s.working)
  const { openReview, disable, refreshStatus, notifyError } = useProviderSyncStore.getState()
  const ref = { provider, sourceId }
  return <div className="provider-sync-controls">
    <div className="provider-sync-heading">
      <span>{provider === 'subsonic' ? 'Sync favorites and ratings' : 'Sync favorites'}</span>
      <button className={`settings-toggle ${status?.enabled ? 'active' : ''}`} role="switch"
        aria-label="Sync with this server" aria-checked={status?.enabled ?? false}
        disabled={!connected || (!status?.enabled && (working || status?.busy))}
        onClick={() => void (status?.enabled ? disable(ref) : openReview(ref))}>{status?.enabled ? 'Enabled' : 'Disabled'}</button>
    </div>
    <p className="settings-note">{provider === 'jellyfin' ? 'Star ratings stay in Astra. ' : ''}
      {status?.enabled ? 'Changes sync automatically with this server.' : 'Off. Enable to compare existing values before syncing.'}</p>
    {status?.error && <p className="remote-source-card-status-error" role="status">{status.error}</p>}
    {status?.enabled && <div className="provider-sync-actions">
      <button className="settings-btn" disabled={working || status.busy || !connected} onClick={() => void openReview(ref)}>
        {status.conflicts ? `Review ${status.conflicts} differences` : 'Review values'}
      </button>
      <button className="settings-btn" disabled={status.busy || !connected} onClick={() => {
        void window.electronAPI.providerSync.refresh(ref).catch(() => notifyError('Could not refresh server favorites and ratings.')).finally(refreshStatus)
      }}>{status.busy ? 'Syncing…' : 'Refresh'}</button>
    </div>}
    {!status?.enabled && status?.busy && <div className="provider-sync-actions">
      <p className="settings-note" role="status">Comparing server values…</p>
      <button className="settings-btn" onClick={() => void disable(ref)}>Cancel comparison</button>
    </div>}
  </div>
}
