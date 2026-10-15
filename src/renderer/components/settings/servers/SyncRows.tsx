import { useState } from 'react'
import type { RemotePlaylistStatus } from '../../../../types/remotePlaylists'
import { useProviderSyncStore } from '../../../stores/providerSyncStore'
import type { ServerProvider } from './serverModel'
import { ServerSwitch } from './ServerParts'
import type { ServerEntry } from './useServers'

/** What each provider can keep in step with Astra. */
export const FAVORITES_COPY: Record<ServerProvider, { label: string; switchLabel: string; sub: string }> = {
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
 * that's confirmed, and cancelling leaves it off. A Plex server's libraries each sync
 * on their own, so one switch covers them all: on while any library syncs, turning on
 * compares them one at a time, and a line names any not on yet (a library added later).
 */
function FavoritesRow({ server }: { server: ServerEntry }) {
  const statuses = useProviderSyncStore(state => state.statuses)
  const working = useProviderSyncStore(state => state.working)
  const copy = FAVORITES_COPY[server.provider]
  const parts = server.sourceIds.map(id => ({
    ref: { provider: server.provider, sourceId: id },
    status: statuses.find(item => item.provider === server.provider && item.sourceId === id),
    name: server.libraries.find(library => library.id === id)?.name ?? null
  }))
  const on = parts.filter(part => part.status?.enabled)
  const off = parts.filter(part => !part.status?.enabled)
  const enabled = on.length > 0
  // `working` covers any server's review loading; `busy` is a source's own comparison.
  const comparing = off.find(part => part.status?.busy)
  const conflicts = on.reduce((sum, part) => sum + (part.status?.conflicts ?? 0), 0)
  const reviewable = on.find(part => (part.status?.conflicts ?? 0) > 0 && !part.status?.busy)
  const failed = parts.find(part => part.status?.error)
  const named = (part: typeof parts[number] | undefined, text: string) => parts.length > 1 && part?.name ? `${part.name}: ${text}` : text
  const { openReview, openReviews, disable } = useProviderSyncStore.getState()
  const turnOff = async () => { for (const part of on) await disable(part.ref) }
  return (
    <div className={`servers-row${server.enabled ? '' : ' is-paused'}`}>
      <div className="servers-row-text">
        <span className="servers-label">{copy.label}</span>
        <span className="servers-sub">{comparing ? `Comparing ${parts.length > 1 && comparing.name ? comparing.name : 'with the server'}…` : copy.sub}</span>
        {enabled && off.length > 0 && !comparing && (
          <span className="servers-sub">
            Not on yet for {off.map(part => part.name ?? server.name).join(', ')}.{' '}
            <button type="button" className="servers-link" disabled={!server.enabled || working}
              onClick={() => void openReviews(off.map(part => part.ref))}>Turn on</button>
          </span>
        )}
        {failed?.status?.error && <span className="servers-sub is-warn">{named(failed, failed.status.error)}</span>}
      </div>
      {comparing && (
        <button type="button" className="servers-link" onClick={() => void disable(comparing.ref)}>Cancel</button>
      )}
      {server.enabled && reviewable && conflicts > 0 && (
        <button type="button" className="servers-link" disabled={working} onClick={() => void openReview(reviewable.ref)}>
          Review {conflicts} {conflicts === 1 ? 'change' : 'changes'}
        </button>
      )}
      <ServerSwitch checked={enabled} label={copy.switchLabel} disabled={!server.enabled || !!comparing || (!enabled && working)}
        onChange={turnOn => void (turnOn ? openReviews(off.map(part => part.ref)) : turnOff())} />
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
