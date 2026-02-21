import { create } from 'zustand'
import {
  DEFAULT_SCOPE_POPOUT_STATE,
  type ScopeKind,
  type ScopePopoutState
} from '../../types/scopePopout'

interface ScopePopoutStore {
  state: ScopePopoutState
  setState: (state: ScopePopoutState) => void
  isPoppedOut: (scope: ScopeKind) => boolean
}

export const useScopePopoutStore = create<ScopePopoutStore>((set, get) => ({
  state: { ...DEFAULT_SCOPE_POPOUT_STATE },
  setState: (state) => set({
    state: {
      ...DEFAULT_SCOPE_POPOUT_STATE,
      ...state,
    }
  }),
  isPoppedOut: (scope) => get().state[scope],
}))
