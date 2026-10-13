import { useEffect, useState } from 'react'
import type { ProviderSyncRef } from '../../../types/providerSync'
import type { RemotePlaylistStatus } from '../../../types/remotePlaylists'
import { useProviderSyncStore } from '../../stores/providerSyncStore'

export default function RemotePlaylistControls({ provider, sourceId, connected }: ProviderSyncRef & { connected: boolean }) {
  const [status, setStatus] = useState<RemotePlaylistStatus | null>(null)
  const [working, setWorking] = useState(false)
  useEffect(() => {
    let active = true
    const refresh = () => { void window.electronAPI.remotePlaylists.status().then(statuses => {
      if (active) setStatus(statuses.find(s => s.provider === provider && s.sourceId === sourceId) ?? null)
    }).catch(() => {}) }
    refresh()
    const unsubscribe = window.electronAPI.remotePlaylists.onChanged(refresh)
    return () => { active = false; unsubscribe() }
  }, [provider, sourceId, connected])
  const run = async (action: () => Promise<void>) => {
    setWorking(true)
    try { await action() }
    catch (error) { useProviderSyncStore.getState().notifyError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Could not sync playlists.') }
    finally { setWorking(false) }
  }
  const ref = { provider, sourceId }
  return <div className="provider-sync-controls">
    <div className="provider-sync-heading"><span>Sync playlists</span>
      <button className={`settings-toggle ${status?.enabled ? 'active' : ''}`} role="switch" aria-label="Sync playlists with this server"
        aria-checked={status?.enabled ?? false} disabled={!status?.enabled && (working || !connected || status?.busy)}
        onClick={() => void run(() => window.electronAPI.remotePlaylists.setEnabled(ref, !status?.enabled))}>
        {status?.enabled ? 'Enabled' : 'Disabled'}
      </button>
    </div>
    <p className="settings-note">{status?.enabled ? 'Edits are saved directly to this server. Playlists refresh automatically.' : 'Off. This server’s playlists stay hidden in Astra.'}</p>
    {status?.error && <p className="remote-source-card-status-error" role="status">{status.error}</p>}
    {status?.enabled && <div className="provider-sync-actions"><button className="settings-btn" disabled={working || status.busy || !connected}
      onClick={() => void run(() => window.electronAPI.remotePlaylists.refresh(ref))}>{status.busy ? 'Syncing…' : 'Refresh playlists'}</button></div>}
  </div>
}
