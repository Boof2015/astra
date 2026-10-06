import { create } from 'zustand'
import type { ProviderSyncChoice, ProviderSyncRef, ProviderSyncReview, ProviderSyncStatus } from '../../types/providerSync'
import { providerSyncKey } from '../../shared/sync/providerState'

interface State {
  statuses: ProviderSyncStatus[]
  review: ProviderSyncReview | null
  working: boolean
  error: string | null
  notice: { message: string; ref?: ProviderSyncRef } | null
  refreshStatus(): Promise<void>
  openReview(ref: ProviderSyncRef): Promise<void>
  apply(choices: Record<string, ProviderSyncChoice>): Promise<void>
  closeReview(): void
  disable(ref: ProviderSyncRef): Promise<void>
  notifyError(message: string): void
  dismissNotice(): void
}
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Could not sync this server.'

export const useProviderSyncStore = create<State>((set, get) => ({
  statuses: [], review: null, working: false, error: null, notice: null,
  refreshStatus: async () => {
    try {
      const statuses = await window.electronAPI.providerSync.status()
      const old = new Map(get().statuses.map(s => [providerSyncKey(s), s]))
      const conflict = statuses.find(s => s.enabled && s.conflicts > (old.get(providerSyncKey(s))?.conflicts ?? 0))
      set({ statuses, ...(conflict ? { notice: { message: 'Server favorites or ratings have changes to review.', ref: conflict } } : {}) })
    } catch { /* Window may be closing. */ }
  },
  openReview: async ref => {
    if (get().working) return
    set({ working: true, error: null, review: null, notice: null })
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
      if (!/AbortError|aborted/i.test(message(error))) set({ notice: { message: message(error) }, error: message(error) })
    }
    finally { set({ working: false }); await get().refreshStatus() }
  },
  apply: async choices => {
    const review = get().review
    if (!review || get().working) return
    set({ working: true, error: null })
    try {
      await window.electronAPI.providerSync.apply(review.token, choices)
      set({ review: null, notice: { message: review.enabling ? 'Server sync enabled.' : 'Server changes reconciled.' } })
    } catch (error) { set({ error: message(error) }) }
    finally { set({ working: false }); await get().refreshStatus() }
  },
  closeReview: () => { if (!get().working) set({ review: null, error: null }) },
  disable: async ref => {
    try {
      await window.electronAPI.providerSync.disable(ref)
      set({ review: null, notice: { message: 'Server sync disabled. Existing favorites and ratings are kept.' } })
    } catch (error) { set({ notice: { message: message(error) } }) }
    await get().refreshStatus()
  },
  notifyError: error => set({ notice: { message: error } }),
  dismissNotice: () => set({ notice: null })
}))
