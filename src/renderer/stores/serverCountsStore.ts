import { create } from 'zustand'

export interface ServerCounts {
  tracks: number
  /** Null while the server is off. */
  albums: number | null
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
      const counts = Object.fromEntries(rows.map(row => [`${row.provider}:${row.sourceId}`, { tracks: row.tracks, albums: row.albums }]))
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
const NONE: ServerCounts = Object.freeze({ tracks: 0, albums: 0 })

/** A server's counts once read: none in the library reads as zero. Safe as a store selector. */
export function serverCounts(state: Pick<ServerCountsState, 'counts' | 'loaded'>, key: string): ServerCounts | null {
  if (!state.loaded) return null
  return state.counts[key] ?? NONE
}
