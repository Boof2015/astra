import { create } from 'zustand'
import type { ProviderSyncChoice, ProviderSyncRef, ProviderSyncReview, ProviderSyncStatus } from '../../types/providerSync'
import { providerSyncKey } from '../../shared/sync/providerState'
import { useServerNoticeStore } from './serverNoticeStore'

interface State {
  statuses: ProviderSyncStatus[]
  review: ProviderSyncReview | null
  working: boolean
  error: string | null
  /**
   * Sources still to compare after the open one, when sync turns on for several at once
   * (each library of a Plex server). Cancelling a comparison drops the rest.
   */
  queue: ProviderSyncRef[]
  /** Which of those comparisons is open, e.g. 1 of 2. Null for a single one. */
  queueStep: { index: number; total: number } | null
  refreshStatus(): Promise<void>
  openReview(ref: ProviderSyncRef): Promise<void>
  /** Turn sync on for several sources: their comparisons, one at a time. */
  openReviews(refs: ProviderSyncRef[]): Promise<void>
  /** Compare the open review's source again (after it expired), keeping any queue after it. */
  refreshReview(): Promise<void>
  apply(choices: Record<string, ProviderSyncChoice>): Promise<void>
  closeReview(): void
  disable(ref: ProviderSyncRef): Promise<void>
  /** A save that didn't go through, as a corner notice. */
  notifyError(message: string): void
}
const notices = () => useServerNoticeStore.getState()
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Could not sync this server.'

export const useProviderSyncStore = create<State>((set, get) => {
  /** Open one comparison. From the queue, it keeps the queue; otherwise it starts over. */
  const open = async (ref: ProviderSyncRef, fromQueue: boolean) => {
    if (get().working) return
    if (!fromQueue) set({ queue: [], queueStep: null })
    set({ working: true, error: null, review: null })
    notices().clear('review', providerSyncKey(ref))
    let applied = false
    try {
      const review = await window.electronAPI.providerSync.review(ref)
      if (review.differences.length) set({ review })
      else {
        // The enable action already expressed intent. With nothing to choose,
        // establish the baseline without presenting empty review/preview steps.
        await window.electronAPI.providerSync.apply(review.token, {})
        applied = true
      }
    }
    catch (error) {
      set({ queue: [], queueStep: null })
      if (!/AbortError|aborted/i.test(message(error))) {
        set({ error: message(error) })
        notices().push({ kind: 'error', message: message(error) })
      }
    }
    finally { set({ working: false }); await get().refreshStatus() }
    if (applied) await next()
  }
  /** The next queued comparison, once the open one is done. */
  const next = async () => {
    const [ref, ...rest] = get().queue
    const step = get().queueStep
    if (!ref) { set({ queueStep: null }); return }
    set({ queue: rest, queueStep: step ? { index: step.index + 1, total: step.total } : null })
    await open(ref, true)
  }
  return {
    statuses: [], review: null, working: false, error: null, queue: [], queueStep: null,
    refreshStatus: async () => {
      try {
        const statuses = await window.electronAPI.providerSync.status()
        const old = new Map(get().statuses.map(s => [providerSyncKey(s), s]))
        set({ statuses })
        // New changes on both sides are worth a notice; the count updates while one is waiting.
        for (const status of statuses) {
          const key = providerSyncKey(status)
          if (status.enabled && status.conflicts > (old.get(key)?.conflicts ?? 0)) {
            notices().push({ kind: 'review', serverKey: key, ref: { provider: status.provider, sourceId: status.sourceId }, count: status.conflicts })
          } else if (!status.enabled || status.conflicts === 0) {
            notices().clear('review', key)
          } else {
            // Fewer changes than before: keep a waiting cue accurate, but don't raise a new one.
            notices().updateQueued('review', key, { count: status.conflicts })
          }
        }
      } catch { /* Window may be closing. */ }
    },
    openReview: ref => open(ref, false),
    refreshReview: async () => {
      const review = get().review
      if (review) await open(review.ref, true)
    },
    openReviews: async refs => {
      if (!refs.length || get().working) return
      set({ queue: refs.slice(1), queueStep: refs.length > 1 ? { index: 1, total: refs.length } : null })
      await open(refs[0], true)
    },
    apply: async choices => {
      const review = get().review
      if (!review || get().working) return
      set({ working: true, error: null })
      let applied = false
      try {
        await window.electronAPI.providerSync.apply(review.token, choices)
        // The switch and the server's row show the result; no confirmation notice.
        set({ review: null })
        notices().clear('review', providerSyncKey(review.ref))
        applied = true
      } catch (error) { set({ error: message(error) }) }
      finally { set({ working: false }); await get().refreshStatus() }
      if (applied) await next()
    },
    closeReview: () => { if (!get().working) set({ review: null, error: null, queue: [], queueStep: null }) },
    disable: async ref => {
      set({ queue: [], queueStep: null })
      try {
        await window.electronAPI.providerSync.disable(ref)
        set({ review: null })
        notices().clear('review', providerSyncKey(ref))
      } catch (error) { notices().push({ kind: 'error', message: message(error) }) }
      await get().refreshStatus()
    },
    notifyError: error => notices().push({ kind: 'error', message: error })
  }
})
