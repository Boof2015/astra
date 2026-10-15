import { create } from 'zustand'
import type { ProviderSyncChoice, ProviderSyncRef, ProviderSyncReview, ProviderSyncStatus } from '../../types/providerSync'
import { providerSyncKey } from '../../shared/sync/providerState'
import { useServerNoticeStore } from './serverNoticeStore'

interface State {
  statuses: ProviderSyncStatus[]
  review: ProviderSyncReview | null
  working: boolean
  error: string | null
  refreshStatus(): Promise<void>
  openReview(ref: ProviderSyncRef): Promise<void>
  apply(choices: Record<string, ProviderSyncChoice>): Promise<void>
  closeReview(): void
  disable(ref: ProviderSyncRef): Promise<void>
  /** A save that didn't go through, as a corner notice. */
  notifyError(message: string): void
}
const notices = () => useServerNoticeStore.getState()
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Could not sync this server.'

export const useProviderSyncStore = create<State>((set, get) => ({
  statuses: [], review: null, working: false, error: null,
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
  openReview: async ref => {
    if (get().working) return
    set({ working: true, error: null, review: null })
    notices().clear('review', providerSyncKey(ref))
    try {
      const review = await window.electronAPI.providerSync.review(ref)
      if (review.differences.length) set({ review })
      else {
        // The enable action already expressed intent. With nothing to choose,
        // establish the baseline without presenting empty review/preview steps.
        await window.electronAPI.providerSync.apply(review.token, {})
      }
    }
    catch (error) {
      if (!/AbortError|aborted/i.test(message(error))) {
        set({ error: message(error) })
        notices().push({ kind: 'error', message: message(error) })
      }
    }
    finally { set({ working: false }); await get().refreshStatus() }
  },
  apply: async choices => {
    const review = get().review
    if (!review || get().working) return
    set({ working: true, error: null })
    try {
      await window.electronAPI.providerSync.apply(review.token, choices)
      // The switch and the server's row show the result; no confirmation notice.
      set({ review: null })
      notices().clear('review', providerSyncKey(review.ref))
    } catch (error) { set({ error: message(error) }) }
    finally { set({ working: false }); await get().refreshStatus() }
  },
  closeReview: () => { if (!get().working) set({ review: null, error: null }) },
  disable: async ref => {
    try {
      await window.electronAPI.providerSync.disable(ref)
      set({ review: null })
      notices().clear('review', providerSyncKey(ref))
    } catch (error) { notices().push({ kind: 'error', message: message(error) }) }
    await get().refreshStatus()
  },
  notifyError: error => notices().push({ kind: 'error', message: error })
}))
