import { useEffect, useMemo, useState } from 'react'
import type { PlexSource } from '../../../../types/plex'
import type { ProviderSyncRef } from '../../../../types/providerSync'
import type { RemotePlaylistStatus } from '../../../../types/remotePlaylists'
import type { JellyfinSourceStatus, SubsonicSourceStatus } from '../../../../types/subsonic'
import { useJellyfinSettingsStore } from '../../../stores/jellyfinSettingsStore'
import { usePlexSettingsStore } from '../../../stores/plexSettingsStore'
import { useProviderSyncStore } from '../../../stores/providerSyncStore'
import { useServerCountsStore } from '../../../stores/serverCountsStore'
import { useServerNoticeStore } from '../../../stores/serverNoticeStore'
import { useSubsonicSettingsStore } from '../../../stores/subsonicSettingsStore'
import { plexServerName } from '../../../../shared/plex/serverName'
import {
  cleanIpcError, combineLibraryStatus, deriveServerState, hostOf, serverProblem, syncSucceeded, PROVIDER_KIND, PROVIDER_MONOGRAM,
  type LibraryStatus, type ServerProblem, type ServerProgress, type ServerProvider, type ServerState
} from './serverModel'

export interface ServerEntry {
  key: string
  provider: ServerProvider
  id: number
  name: string
  kind: string
  monogram: string
  /** Host and port for address servers, the music libraries for Plex. */
  host: string
  /** Full server address; Plex connects through addresses Plex chooses, so it has none to show. */
  address: string | null
  user: string
  /**
   * Every source behind this entry: the server itself, or each library of a Plex server
   * (the one that owns its playlists first, whose id is also `id`). Actions cover them all.
   */
  sourceIds: number[]
  /** A Plex server's libraries, each with its own status. Empty for other servers. */
  libraries: ServerLibrary[]
  enabled: boolean
  state: ServerState
  /** Set while the state is 'failed'. */
  problem: ServerProblem | null
  error: string | null
  progress: ServerProgress | null
  lastSyncAt: number | null
  createdAt: number
  /** Plex libraries on one server share their playlists, under the lowest-numbered library. */
  playlistRef: ProviderSyncRef
  playlistPeers: number
}

export interface ServerLibrary extends LibraryStatus {
  id: number
  /** "plex:<id>", the key its tracks, counts and filters use. */
  key: string
}

type StatusItem = SubsonicSourceStatus | JellyfinSourceStatus

function entry(provider: ServerProvider, source: {
  id: number; name: string; base_url: string; username: string; enabled: number; last_status: string
  last_error: string | null; last_error_kind?: string | null; last_sync_at: number | null; created_at: number
}, status: StatusItem | undefined, extra: {
  host?: string; playlistRef?: ProviderSyncRef; playlistPeers?: number
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
    sourceIds: [source.id],
    libraries: [],
    enabled,
    state,
    problem: state === 'failed' ? serverProblem(status ? status.errorKind : source.last_error_kind) : null,
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
      ...plexServers(plexSources, id => statusOf(plexStatus?.sources, id))
    ]
    return servers.sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key))
  }, [subsonicSources, subsonicStatus, jellyfinSources, jellyfinStatus, plexSources, plexStatus])
}

/**
 * One entry per Plex server: its libraries (same account and server) share a name, a status
 * made from theirs, and the key of the library that owns the server's playlists.
 */
function plexServers(sources: PlexSource[], statusOf: (id: number) => StatusItem | undefined): ServerEntry[] {
  const groups = new Map<string, PlexSource[]>()
  for (const source of sources) {
    const groupKey = JSON.stringify([source.account_id, source.server_id])
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), source])
  }
  return [...groups.values()].map(group => {
    const members = [...group].sort((a, b) => a.id - b.id)
    const owner = members[0]
    const libraries: ServerLibrary[] = members.map(source => {
      const own = entry('plex', source, statusOf(source.id))
      return { id: source.id, key: own.key, name: source.library_name, enabled: own.enabled, state: own.state,
        problem: own.problem, error: own.error, progress: own.progress, lastSyncAt: own.lastSyncAt }
    })
    const base = entry('plex', owner, statusOf(owner.id), {
      host: members.map(source => source.library_name).join(', '),
      playlistRef: { provider: 'plex', sourceId: owner.id },
      playlistPeers: members.length
    })
    const status = combineLibraryStatus(libraries)
    return { ...base, ...status, name: plexServerName(owner), sourceIds: members.map(source => source.id), libraries,
      createdAt: Math.min(...members.map(source => source.created_at)) }
  })
}

/** The server a key belongs to; a Plex library's key finds its server. */
export function serverForKey<T extends Pick<ServerEntry, 'key' | 'provider' | 'sourceIds'>>(servers: readonly T[], key: string | undefined): T | undefined {
  if (!key) return undefined
  return servers.find(server => server.key === key || server.sourceIds.some(id => `${server.provider}:${id}` === key))
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
  // A Plex track names its server, as Settings does, not "<server> · <library>".
  const plex = usePlexSettingsStore(state => {
    const source = provider === 'plex' ? state.sources.find(item => item.id === id) : undefined
    return source ? plexServerName(source) : null
  })
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

/** A server to act on: its key's id, plus every source behind it (each Plex library). */
type ServerRef = Pick<ServerEntry, 'provider' | 'id'> & { sourceIds?: number[] }
const sourcesOf = (server: ServerRef) => server.sourceIds?.length ? server.sourceIds : [server.id]

async function syncSource(provider: ServerProvider, id: number): Promise<void> {
  if (provider === 'subsonic') await window.electronAPI.subsonic.syncSource(id)
  else if (provider === 'jellyfin') await window.electronAPI.jellyfin.syncSource(id)
  else await window.electronAPI.plex.syncSource(id)
}

/**
 * Sync one server (each of a Plex server's libraries, one after another). A failure shows
 * on the server itself (its status and error), so it isn't repeated as a store-wide error.
 * Resolves to whether every source synced.
 */
export async function syncServer(server: ServerRef): Promise<boolean> {
  const key = `${server.provider}:${server.id}`
  const ids = sourcesOf(server)
  userSyncs.add(key)
  let rejected = false
  try {
    for (const id of ids) {
      try { await syncSource(server.provider, id) } catch { rejected = true /* Shown on the server's row. */ }
    }
  } finally {
    try { await refreshProvider(server.provider) } catch { /* The store reports its own refresh errors. */ }
    userSyncs.delete(key)
  }
  return !rejected && ids.every(id => syncSucceeded(...recordedStatus(server.provider, id)))
}

/** A source's live status and its stored status, as the stores have them after a refresh. */
function recordedStatus(provider: ServerProvider, id: number): [string | undefined, string | undefined] {
  const state = provider === 'subsonic' ? useSubsonicSettingsStore.getState()
    : provider === 'jellyfin' ? useJellyfinSettingsStore.getState() : usePlexSettingsStore.getState()
  const live = (state.status?.sources as { sourceId: number; status: string }[] | undefined)?.find(item => item.sourceId === id)?.status
  const stored = (state.sources as { id: number; last_status: string }[]).find(item => item.id === id)?.last_status
  return [live, stored]
}

/**
 * After the add window closes: the first sync, then the sync options chosen there.
 * Playlist sync turns on after the first sync, so its first refresh finds the tracks.
 * Favorites/ratings need a comparison, which needs the server's values, so it runs only
 * once that sync worked; the switch turns on when the comparison is confirmed (for a Plex
 * server, one library at a time). Libraries added to a Plex server already in Astra pass
 * just those (`server.sourceIds`), so only they sync and the cue counts only their tracks.
 */
export async function finishAddingServer(server: ServerRef, wants: { favorites: boolean; playlists: boolean }): Promise<void> {
  const ids = sourcesOf(server)
  const synced = await syncServer(server)
  if (synced) {
    // This read's own result: the store may hold an older snapshot (from before the music
    // arrived) if a newer read replaced this one, or this one failed. No fresh count, no number.
    const counts = await useServerCountsStore.getState().refresh()
    const tracks = counts ? ids.reduce((sum, id) => sum + (counts[`${server.provider}:${id}`]?.tracks ?? 0), 0) : undefined
    useServerNoticeStore.getState().push({ kind: 'ready', serverKey: `${server.provider}:${server.id}`, count: tracks })
  }
  if (wants.playlists) {
    // The main process maps a Plex library to the one that owns its server's playlists.
    await window.electronAPI.remotePlaylists.setEnabled({ provider: server.provider, sourceId: server.id }, true)
      .catch(error => useProviderSyncStore.getState().notifyError(cleanIpcError(error, 'Could not turn on playlist sync.')))
  }
  if (wants.favorites && synced) await useProviderSyncStore.getState().openReviews(ids.map(id => ({ provider: server.provider, sourceId: id })))
}

/**
 * Remove a server (every library of a Plex server), keeping its tracks as unavailable or
 * deleting them. Rejects with a readable message.
 */
export async function removeServer(server: ServerRef, deleteTracks: boolean): Promise<void> {
  // Through the API, then a refresh that reports its own errors: a failed refresh isn't a failed removal.
  // The library that owns a Plex server's playlists goes last, so they don't move between libraries on the way.
  try {
    for (const id of [...sourcesOf(server)].reverse()) {
      if (server.provider === 'subsonic') await window.electronAPI.subsonic.deleteSource(id, deleteTracks)
      else if (server.provider === 'jellyfin') await window.electronAPI.jellyfin.deleteSource(id, deleteTracks)
      else await window.electronAPI.plex.deleteSource(id, deleteTracks)
    }
  } catch (error) {
    await refreshProvider(server.provider)
    throw new Error(cleanIpcError(error, 'Could not remove this server.'))
  }
  await refreshProvider(server.provider)
}

/** Remove one library of a Plex server. Rejects with a readable message. */
export async function removePlexLibrary(id: number, deleteTracks: boolean): Promise<void> {
  try { await window.electronAPI.plex.deleteSource(id, deleteTracks) }
  catch (error) { throw new Error(cleanIpcError(error, 'Could not remove this library.')) }
  await refreshProvider('plex')
}

/** "Use this server". Turning a server back on syncs it, so its music returns right away. */
export async function setServerEnabled(server: ServerRef, enabled: boolean): Promise<void> {
  try {
    for (const id of sourcesOf(server)) {
      if (server.provider === 'subsonic') await window.electronAPI.subsonic.updateSource(id, { enabled })
      else if (server.provider === 'jellyfin') await window.electronAPI.jellyfin.updateSource(id, { enabled })
      else await window.electronAPI.plex.updateSource(id, { enabled })
    }
  } catch (error) {
    // Shown under the servers. Refresh first: some of a Plex server's libraries may have
    // changed already, and a refresh clears the store's error.
    const message = cleanIpcError(error, 'Could not update this server.')
    await refreshProvider(server.provider)
    if (server.provider === 'subsonic') useSubsonicSettingsStore.setState({ errorMessage: message })
    else if (server.provider === 'jellyfin') useJellyfinSettingsStore.setState({ errorMessage: message })
    else usePlexSettingsStore.setState({ error: message })
    return
  }
  await refreshProvider(server.provider)
  if (enabled) void syncServer(server)
}
