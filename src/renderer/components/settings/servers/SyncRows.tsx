import { useState } from 'react'
import type { RemotePlaylistStatus } from '../../../../types/remotePlaylists'
import { useProviderSyncStore } from '../../../stores/providerSyncStore'
import type { ServerProvider } from './serverModel'
import { ServerSwitch } from './ServerParts'
import { useProviderSyncStatus, type ServerEntry } from './useServers'

/** What each provider can keep in step with Astra. */
const FAVORITES_COPY: Record<ServerProvider, { label: string; switchLabel: string; sub: string }> = {
  subsonic: {
    label: 'Sync favorites & ratings',
    switchLabel: 'Sync favorites and ratings',
    sub: 'Favorites and whole-star ratings stay the same in Astra and on the server.'
  },
  jellyfin: {
    label: 'Sync favorites',
    switchLabel: 'Sync favorites',
    sub: 'Favorites stay the same in Astra and on Jellyfin. Ratings stay in Astra.'
  },
  plex: {
    label: 'Sync ratings',
    switchLabel: 'Sync ratings',
    sub: 'Half-star ratings stay the same in Astra and on Plex. Favorites stay in Astra.'
  }
}

const cleanError = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : fallback

/**
 * Turning sync on compares existing values first; the switch only turns on once
 * that's confirmed, and cancelling leaves it off.
 */
function FavoritesRow({ server }: { server: ServerEntry }) {
  const ref = { provider: server.provider, sourceId: server.id }
  const status = useProviderSyncStatus(ref)
  const working = useProviderSyncStore(state => state.working)
  const copy = FAVORITES_COPY[server.provider]
  const enabled = status?.enabled ?? false
  // `working` covers any server's review loading; `busy` is this server's own comparison.
  const comparing = !enabled && !!status?.busy
  const { openReview, disable } = useProviderSyncStore.getState()
  return (
    <div className={`servers-row${server.enabled ? '' : ' is-paused'}`}>
      <div className="servers-row-text">
        <span className="servers-label">{copy.label}</span>
        <span className="servers-sub">{comparing ? 'Comparing with the server…' : copy.sub}</span>
        {status?.error && <span className="servers-sub is-warn">{status.error}</span>}
      </div>
      {comparing && (
        <button type="button" className="servers-link" onClick={() => void disable(ref)}>Cancel</button>
      )}
      {server.enabled && enabled && status && status.conflicts > 0 && (
        <button type="button" className="servers-link" disabled={working || status.busy} onClick={() => void openReview(ref)}>
          Review {status.conflicts} {status.conflicts === 1 ? 'change' : 'changes'}
        </button>
      )}
      <ServerSwitch checked={enabled} label={copy.switchLabel} disabled={!server.enabled || comparing || (!enabled && working)}
        onChange={on => void (on ? openReview(ref) : disable(ref))} />
    </div>
  )
}

function PlaylistsRow({ server, status }: { server: ServerEntry; status: RemotePlaylistStatus | undefined }) {
  const [pending, setPending] = useState(false)
  const enabled = status?.enabled ?? false
  const shared = server.provider === 'plex' && server.playlistPeers > 1 ? ' Shared by all libraries on this Plex server.' : ''
  const toggle = async (on: boolean) => {
    setPending(true)
    try { await window.electronAPI.remotePlaylists.setEnabled(server.playlistRef, on) }
    catch (error) { useProviderSyncStore.getState().notifyError(cleanError(error, 'Could not change playlist sync.')) }
    finally { setPending(false) }
  }
  return (
    <div className={`servers-row${server.enabled ? '' : ' is-paused'}`}>
      <div className="servers-row-text">
        <span className="servers-label">Sync playlists</span>
        <span className="servers-sub">Show this server’s playlists in Astra and save your edits back to it.{shared}</span>
        {status?.error && <span className="servers-sub is-warn">{status.error}</span>}
      </div>
      <ServerSwitch checked={enabled} label="Sync playlists" disabled={!server.enabled || pending || !!status?.busy}
        onChange={on => void toggle(on)} />
    </div>
  )
}

export function SyncRows({ server, playlistStatuses }: { server: ServerEntry; playlistStatuses: RemotePlaylistStatus[] }) {
  const playlistStatus = playlistStatuses.find(item =>
    item.provider === server.playlistRef.provider && item.sourceId === server.playlistRef.sourceId)
  return (
    <>
      <FavoritesRow server={server} />
      <PlaylistsRow server={server} status={playlistStatus} />
    </>
  )
}
