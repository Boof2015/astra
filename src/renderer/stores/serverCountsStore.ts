import { useMemo } from 'react'
import { create } from 'zustand'

export interface ServerCounts {
  tracks: number
  /** Null while the server is off. */
  albums: number | null
  /** Across every source of its server (a Plex server's libraries). */
  serverAlbums: number | null
}

interface ServerCountsState {
  /** By "provider:id". A server with no tracks in the library has no entry. */
  counts: Record<string, ServerCounts>
  /** Whether the counts have been read at least once. */
  loaded: boolean
  /**
   * Read the counts again, e.g. after a sync. Resolves with this read's own counts, even
   * if a newer read has since replaced it in the store, or null if it failed.
   */
  refresh(): Promise<Record<string, ServerCounts> | null>
}

let latestRequest = 0

/** How much of each server is in the library, for Settings → Servers and the ready cue. */
export const useServerCountsStore = create<ServerCountsState>((set) => ({
  counts: {},
  loaded: false,
  refresh: async () => {
    const request = ++latestRequest
    try {
      const rows = await window.electronAPI.servers.counts()
      const counts = Object.fromEntries(rows.map(row => [`${row.provider}:${row.sourceId}`,
        { tracks: row.tracks, albums: row.albums, serverAlbums: row.serverAlbums }]))
      // An older read finishing late doesn't overwrite a newer one.
      if (request === latestRequest) set({ counts, loaded: true })
      return counts
    } catch {
      // Counts are extra detail; without them the rows that show them stay hidden.
      return null
    }
  }
}))

// One shared value, so a store selector returning it stays stable.
const NONE: ServerCounts = Object.freeze({ tracks: 0, albums: 0, serverAlbums: 0 })

/** A source's counts once read: none in the library reads as zero. Safe as a store selector. */
export function serverCounts(state: Pick<ServerCountsState, 'counts' | 'loaded'>, key: string): ServerCounts | null {
  if (!state.loaded) return null
  return state.counts[key] ?? NONE
}

/**
 * A server's counts, across every source behind it (each Plex library): tracks added up,
 * albums counted once for the server. Null until read. Selects plain numbers, so it stays
 * stable for React.
 */
export function useServerTotals(server: { provider: string; sourceIds: number[] }): { tracks: number; albums: number | null } | null {
  const keys = server.sourceIds.map(id => `${server.provider}:${id}`)
  const loaded = useServerCountsStore(state => state.loaded)
  const tracks = useServerCountsStore(state => keys.reduce((sum, key) => sum + (state.counts[key]?.tracks ?? 0), 0))
  // Every library of a server carries the same server-wide count; one with no tracks has no row.
  const albums = useServerCountsStore(state => keys.map(key => state.counts[key]).find(Boolean)?.serverAlbums ?? 0)
  return useMemo(() => loaded ? { tracks, albums } : null, [loaded, tracks, albums])
}
