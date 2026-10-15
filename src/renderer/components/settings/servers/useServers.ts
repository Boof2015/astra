import { useEffect, useMemo, useState } from 'react'
import type { ProviderSyncRef } from '../../../../types/providerSync'
import type { RemotePlaylistStatus } from '../../../../types/remotePlaylists'
import type { JellyfinSourceStatus, SubsonicSourceStatus } from '../../../../types/subsonic'
import { useJellyfinSettingsStore } from '../../../stores/jellyfinSettingsStore'
import { usePlexSettingsStore } from '../../../stores/plexSettingsStore'
import { useProviderSyncStore } from '../../../stores/providerSyncStore'
import { useServerNoticeStore } from '../../../stores/serverNoticeStore'
import { useSubsonicSettingsStore } from '../../../stores/subsonicSettingsStore'
import {
  cleanIpcError, deriveServerState, hostOf, syncSucceeded, PROVIDER_KIND, PROVIDER_MONOGRAM,
  type ServerProgress, type ServerProvider, type ServerState
} from './serverModel'

export interface ServerEntry {
  key: string
  provider: ServerProvider
  id: number
  name: string
  kind: string
  monogram: string
  /** Host and port for address servers, the music library for Plex. */
  host: string
  /** Full server address; Plex connects through addresses Plex chooses, so it has none to show. */
  address: string | null
  user: string
  /** Plex connects one music library per entry. */
  libraryName: string | null
  enabled: boolean
  state: ServerState
  error: string | null
  progress: ServerProgress | null
  lastSyncAt: number | null
  createdAt: number
  /** Plex libraries on one server share their playlists, under the lowest-numbered library. */
  playlistRef: ProviderSyncRef
  playlistPeers: number
}

type StatusItem = SubsonicSourceStatus | JellyfinSourceStatus

function entry(provider: ServerProvider, source: {
  id: number; name: string; base_url: string; username: string; enabled: number; last_status: string
  last_error: string | null; last_sync_at: number | null; created_at: number
}, status: StatusItem | undefined, extra: {
  host?: string; libraryName?: string; playlistRef?: ProviderSyncRef; playlistPeers?: number
} = {}): ServerEntry {
  const enabled = source.enabled === 1
  const progress = status?.progress
    ? { activity: status.progress.activity, current: status.progress.current, total: status.progress.total }
    : null
  const state = deriveServerState(enabled, status?.status ?? source.last_status, progress)
  return {
    key: `${provider}:${source.id}`,
    provider,
    id: source.id,
    name: source.name,
    kind: PROVIDER_KIND[provider],
    monogram: PROVIDER_MONOGRAM[provider],
    host: extra.host ?? hostOf(source.base_url),
    address: provider === 'plex' ? null : source.base_url,
    user: source.username,
    libraryName: extra.libraryName ?? null,
    enabled,
    state,
    error: state === 'failed' ? status?.error ?? source.last_error : null,
    progress: state === 'syncing' ? progress : null,
    lastSyncAt: status?.lastSyncAt ?? source.last_sync_at,
    createdAt: source.created_at,
    playlistRef: extra.playlistRef ?? { provider, sourceId: source.id },
    playlistPeers: extra.playlistPeers ?? 1
  }
}

/** Every connected server, from the three provider stores, oldest first. */
export function useServers(): ServerEntry[] {
  const subsonicSources = useSubsonicSettingsStore(state => state.sources)
  const subsonicStatus = useSubsonicSettingsStore(state => state.status)
  const jellyfinSources = useJellyfinSettingsStore(state => state.sources)
  const jellyfinStatus = useJellyfinSettingsStore(state => state.status)
  const plexSources = usePlexSettingsStore(state => state.sources)
  const plexStatus = usePlexSettingsStore(state => state.status)

  return useMemo(() => {
    const statusOf = (statuses: StatusItem[] | undefined, id: number) => statuses?.find(item => item.sourceId === id)
    const servers = [
      ...subsonicSources.map(source => entry('subsonic', source, statusOf(subsonicStatus?.sources, source.id))),
      ...jellyfinSources.map(source => entry('jellyfin', source, statusOf(jellyfinStatus?.sources, source.id))),
      ...plexSources.map(source => {
        const peers = plexSources.filter(peer => peer.account_id === source.account_id && peer.server_id === source.server_id)
          .sort((a, b) => a.id - b.id)
        return entry('plex', source, statusOf(plexStatus?.sources, source.id), {
          host: source.library_name,
          libraryName: source.library_name,
          playlistRef: { provider: 'plex', sourceId: peers[0]?.id ?? source.id },
          playlistPeers: peers.length
        })
      })
    ]
    return servers.sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key))
  }, [subsonicSources, subsonicStatus, jellyfinSources, jellyfinStatus, plexSources, plexStatus])
}

/** Store-level failures (saving a change, listing servers). Per-server sync errors show on the server. */
export function useServerStoreErrors(): string[] {
  const subsonic = useSubsonicSettingsStore(state => state.errorMessage)
  const jellyfin = useJellyfinSettingsStore(state => state.errorMessage)
  const plex = usePlexSettingsStore(state => state.error)
  return useMemo(() => [...new Set([subsonic, jellyfin, plex].filter(Boolean))], [subsonic, jellyfin, plex])
}

export function useProviderSyncStatus(ref: ProviderSyncRef) {
  return useProviderSyncStore(state => state.statuses.find(item => item.provider === ref.provider && item.sourceId === ref.sourceId))
}

/** Playlist sync status for every server, kept current by `remote-playlists:changed`. */
export function useRemotePlaylistStatuses(): RemotePlaylistStatus[] {
  const [statuses, setStatuses] = useState<RemotePlaylistStatus[]>([])
  useEffect(() => {
    let active = true
    const refresh = () => {
      void window.electronAPI.remotePlaylists.status()
        .then(value => { if (active) setStatuses(value) })
        .catch(() => {})
    }
    refresh()
    const unsubscribe = window.electronAPI.remotePlaylists.onChanged(refresh)
    return () => { active = false; unsubscribe() }
  }, [])
  return statuses
}

/** Re-render every half minute so "synced 4 min ago" stays true. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

/** A server's name, for places that only know a track's source (the transport tooltip, the pipeline). */
export function useServerName(provider: string | undefined, id: number | undefined): string | null {
  const subsonic = useSubsonicSettingsStore(state => provider === 'subsonic' ? state.sources.find(item => item.id === id)?.name ?? null : null)
  const jellyfin = useJellyfinSettingsStore(state => provider === 'jellyfin' ? state.sources.find(item => item.id === id)?.name ?? null : null)
  const plex = usePlexSettingsStore(state => provider === 'plex' ? state.sources.find(item => item.id === id)?.name ?? null : null)
  return subsonic ?? jellyfin ?? plex
}

/* ---------- Actions ---------- */

/**
 * Syncs the user started (Sync now, Retry, the first sync after adding). Their result
 * shows on the server's row, so a failure during one doesn't also get a corner notice.
 */
const userSyncs = new Set<string>()
export const isUserSyncing = (key: string) => userSyncs.has(key)

async function refreshProvider(provider: ServerProvider): Promise<void> {
  if (provider === 'subsonic') await useSubsonicSettingsStore.getState().refresh()
  else if (provider === 'jellyfin') await useJellyfinSettingsStore.getState().refresh()
  else await usePlexSettingsStore.getState().refresh()
}

/**
 * Sync one server. A failure shows on the server itself (its status and error),
 * so it isn't repeated as a store-wide error. Resolves to whether it succeeded.
 */
export async function syncServer(server: Pick<ServerEntry, 'provider' | 'id'>): Promise<boolean> {
  const key = `${server.provider}:${server.id}`
  userSyncs.add(key)
  let rejected = false
  try {
    if (server.provider === 'subsonic') await window.electronAPI.subsonic.syncSource(server.id)
    else if (server.provider === 'jellyfin') await window.electronAPI.jellyfin.syncSource(server.id)
    else await window.electronAPI.plex.syncSource(server.id)
  } catch { rejected = true /* Shown on the server's row. */ }
  try {
    await refreshProvider(server.provider)
    return !rejected && syncSucceeded(...recordedStatus(server))
  } finally { userSyncs.delete(key) }
}

/** The source's live status and its stored status, as the stores have them after a refresh. */
function recordedStatus(server: Pick<ServerEntry, 'provider' | 'id'>): [string | undefined, string | undefined] {
  const state = server.provider === 'subsonic' ? useSubsonicSettingsStore.getState()
    : server.provider === 'jellyfin' ? useJellyfinSettingsStore.getState() : usePlexSettingsStore.getState()
  const live = (state.status?.sources as { sourceId: number; status: string }[] | undefined)?.find(item => item.sourceId === server.id)?.status
  const stored = (state.sources as { id: number; last_status: string }[]).find(item => item.id === server.id)?.last_status
  return [live, stored]
}

/**
 * After the add window closes: the first sync, then the sync options chosen there.
 * Playlist sync turns on after the first sync, so its first refresh finds the tracks.
 * Favorites/ratings need a comparison, which needs the server's values, so it runs only
 * once that sync worked; the switch turns on when the comparison is confirmed.
 */
export async function finishAddingServer(server: Pick<ServerEntry, 'provider' | 'id'>,
  wants: { favorites: boolean; playlists: boolean }): Promise<void> {
  const synced = await syncServer(server)
  if (synced) useServerNoticeStore.getState().push({ kind: 'ready', serverKey: `${server.provider}:${server.id}` })
  if (wants.playlists) {
    // The main process maps a Plex library to the one that owns its server's playlists.
    await window.electronAPI.remotePlaylists.setEnabled({ provider: server.provider, sourceId: server.id }, true)
      .catch(error => useProviderSyncStore.getState().notifyError(cleanIpcError(error, 'Could not turn on playlist sync.')))
  }
  if (wants.favorites && synced) await useProviderSyncStore.getState().openReview({ provider: server.provider, sourceId: server.id })
}

/** Remove a server, keeping its tracks as unavailable or deleting them. Rejects with a readable message. */
export async function removeServer(server: Pick<ServerEntry, 'provider' | 'id'>, deleteTracks: boolean): Promise<void> {
  // Through the API, then a refresh that reports its own errors: a failed refresh isn't a failed removal.
  try {
    if (server.provider === 'subsonic') await window.electronAPI.subsonic.deleteSource(server.id, deleteTracks)
    else if (server.provider === 'jellyfin') await window.electronAPI.jellyfin.deleteSource(server.id, deleteTracks)
    else await window.electronAPI.plex.deleteSource(server.id, deleteTracks)
  } catch (error) {
    throw new Error(cleanIpcError(error, 'Could not remove this server.'))
  }
  await refreshProvider(server.provider)
}

/** "Use this server". Turning a server back on syncs it, so its music returns right away. */
export async function setServerEnabled(server: Pick<ServerEntry, 'provider' | 'id'>, enabled: boolean): Promise<void> {
  try {
    if (server.provider === 'subsonic') await window.electronAPI.subsonic.updateSource(server.id, { enabled })
    else if (server.provider === 'jellyfin') await window.electronAPI.jellyfin.updateSource(server.id, { enabled })
    else await window.electronAPI.plex.updateSource(server.id, { enabled })
  } catch (error) {
    // Shown under the servers; a failed refresh afterwards isn't a failed change.
    const message = cleanIpcError(error, 'Could not update this server.')
    if (server.provider === 'subsonic') useSubsonicSettingsStore.setState({ errorMessage: message })
    else if (server.provider === 'jellyfin') useJellyfinSettingsStore.setState({ errorMessage: message })
    else usePlexSettingsStore.setState({ error: message })
    return
  }
  await refreshProvider(server.provider)
  if (enabled) void syncServer(server)
}
