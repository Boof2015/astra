import { create } from 'zustand'
import type { ProviderSyncRef } from '../../types/providerSync'

/**
 * Server cues for the corner, shown one at a time like Astra's other cues. Only things
 * that happen in the background get one; the result of something the user just did
 * shows where they did it.
 * - review: changes to settle on both sides (the server's row keeps "Review N changes")
 * - problem: a server stopped syncing (once per outage)
 * - ready: a newly added server finished its first sync
 * - error: a save that didn't go through
 */
export type ServerNoticeKind = 'review' | 'problem' | 'ready' | 'error'

export interface ServerNotice {
  id: number
  kind: ServerNoticeKind
  /** "provider:id" of the server it's about, when it's about one. */
  serverKey?: string
  ref?: ProviderSyncRef
  /** Review: how many changes are waiting. Ready: how many tracks the first sync added. */
  count?: number
  /** Problem: what went wrong, for the right words and fix. */
  problem?: 'offline' | 'signed-out' | 'sync'
  /** Error text, or extra detail for a problem. */
  message?: string
}

interface ServerNoticeState {
  /** Shown one at a time, oldest first. */
  queue: ServerNotice[]
  push(notice: Omit<ServerNotice, 'id'>): void
  dismiss(id: number): void
  /** Drop a server's notices of one kind, e.g. a review the user has opened. */
  clear(kind: ServerNoticeKind, serverKey: string): void
  /** Drop every notice about a server, e.g. once it's removed. */
  clearServer(serverKey: string): void
  /** Change a queued notice in place; does nothing if there isn't one (a dismissed one stays dismissed). */
  updateQueued(kind: ServerNoticeKind, serverKey: string, patch: Partial<Omit<ServerNotice, 'id' | 'kind' | 'serverKey'>>): void
}

let nextId = 1

export const useServerNoticeStore = create<ServerNoticeState>((set) => ({
  queue: [],
  push: notice => set(state => {
    // The same news about the same server replaces the queued one rather than stacking.
    const existing = notice.serverKey
      ? state.queue.findIndex(item => item.kind === notice.kind && item.serverKey === notice.serverKey)
      : notice.kind === 'error' ? state.queue.findIndex(item => item.kind === 'error' && item.message === notice.message) : -1
    if (existing >= 0) {
      const queue = [...state.queue]
      queue[existing] = { ...queue[existing], ...notice }
      return { queue }
    }
    return { queue: [...state.queue, { ...notice, id: nextId++ }] }
  }),
  dismiss: id => set(state => ({ queue: state.queue.filter(item => item.id !== id) })),
  clear: (kind, serverKey) => set(state => ({ queue: state.queue.filter(item => !(item.kind === kind && item.serverKey === serverKey)) })),
  clearServer: serverKey => set(state => ({ queue: state.queue.filter(item => item.serverKey !== serverKey) })),
  updateQueued: (kind, serverKey, patch) => set(state => {
    const index = state.queue.findIndex(item => item.kind === kind && item.serverKey === serverKey)
    if (index < 0) return state
    const queue = [...state.queue]
    queue[index] = { ...queue[index], ...patch }
    return { queue }
  })
}))

/**
 * Which servers get an outage notice now, whose notice can go, and which servers were
 * removed (all their notices go). One notice per outage: `memory.notified` remembers
 * servers already told about (or whose failure the user saw happen during their own
 * sync) until they're healthy again or turned off. Still syncing between failed
 * attempts is the same outage. A server only counts as removed once it has been seen
 * (`memory.known`), so notices queued before the server list first loads survive.
 */
/** `memberKeys`: every source behind the server (each Plex library), whose own cues go when it's removed. */
type OutageServer = { key: string; state: string; error: string | null; problem?: 'offline' | 'signed-out' | 'sync' | null; memberKeys?: string[] }

export function planOutageNotices(
  servers: readonly OutageServer[],
  memory: { notified: Set<string>; known: Set<string> },
  isUserSyncing: (key: string) => boolean
): { push: OutageServer[]; update: OutageServer[]; clear: string[]; removed: string[] } {
  const push: OutageServer[] = [], update: OutageServer[] = [], clear: string[] = [], removed: string[] = []
  const { notified, known } = memory
  // A Plex library's review cues are keyed by the library, so each library counts as known
  // too: removing one library (or the whole server) removes its cues.
  const present = new Set(servers.flatMap(server => [server.key, ...(server.memberKeys ?? [])]))
  for (const key of [...known]) {
    if (present.has(key)) continue
    known.delete(key)
    notified.delete(key)
    removed.push(key)
  }
  for (const key of present) known.add(key)
  for (const server of servers) {
    if (server.state === 'failed') {
      // Same outage: a waiting cue keeps up if the problem changes (offline, then signed out).
      if (notified.has(server.key)) { update.push(server); continue }
      notified.add(server.key)
      if (!isUserSyncing(server.key)) push.push(server)
    } else if (server.state === 'connected' || server.state === 'off') {
      notified.delete(server.key)
      clear.push(server.key)
    }
  }
  return { push, update, clear, removed }
}
