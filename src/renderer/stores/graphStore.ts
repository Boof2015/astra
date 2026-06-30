import { create } from 'zustand'
import { normalizeKey } from '../utils/albumIdentity'

export type ArtistGraphMode = 'full' | 'focus'

export const LIBRARY_GRAPH_ENABLED_STORAGE_KEY = 'astra-experimental-library-graph-enabled-v1'
const DEFAULT_EDGE_WEIGHT_THRESHOLD = 2
const DEFAULT_FOCUS_NEIGHBOR_LIMIT = 8
const FOCUS_NEIGHBOR_INCREMENT = 8

function readEnabledPreference(): boolean {
  try {
    return localStorage.getItem(LIBRARY_GRAPH_ENABLED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function persistEnabledPreference(enabled: boolean): void {
  try {
    localStorage.setItem(LIBRARY_GRAPH_ENABLED_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // Ignore storage failures and continue with in-memory state.
  }
}

interface GraphStore {
  enabled: boolean
  mode: ArtistGraphMode
  focusedArtistKey: string | null
  focusedArtistName: string | null
  selectedArtistKey: string | null
  edgeWeightThreshold: number
  focusNeighborLimit: number
  setEnabled: (enabled: boolean) => void
  openFullMap: () => void
  openFocusedGraph: (artistName: string) => void
  setSelectedArtistKey: (artistKey: string | null) => void
  setEdgeWeightThreshold: (threshold: number) => void
  expandFocusNeighbors: () => void
  resetFocusNeighbors: () => void
}

export const useGraphStore = create<GraphStore>((set) => ({
  enabled: readEnabledPreference(),
  mode: 'full',
  focusedArtistKey: null,
  focusedArtistName: null,
  selectedArtistKey: null,
  edgeWeightThreshold: DEFAULT_EDGE_WEIGHT_THRESHOLD,
  focusNeighborLimit: DEFAULT_FOCUS_NEIGHBOR_LIMIT,
  setEnabled: (enabled) => {
    const normalized = Boolean(enabled)
    persistEnabledPreference(normalized)
    set((state) => ({
      enabled: normalized,
      mode: normalized ? state.mode : 'full',
      focusedArtistKey: normalized ? state.focusedArtistKey : null,
      focusedArtistName: normalized ? state.focusedArtistName : null,
      selectedArtistKey: normalized ? state.selectedArtistKey : null,
      edgeWeightThreshold: normalized ? state.edgeWeightThreshold : DEFAULT_EDGE_WEIGHT_THRESHOLD,
      focusNeighborLimit: DEFAULT_FOCUS_NEIGHBOR_LIMIT
    }))
  },
  openFullMap: () => set({
    mode: 'full',
    focusedArtistKey: null,
    focusedArtistName: null,
    selectedArtistKey: null,
    focusNeighborLimit: DEFAULT_FOCUS_NEIGHBOR_LIMIT
  }),
  openFocusedGraph: (artistName) => {
    const normalizedArtistName = artistName.trim()
    const focusedArtistKey = normalizeKey(normalizedArtistName)
    set({
      mode: 'focus',
      focusedArtistKey: focusedArtistKey || null,
      focusedArtistName: normalizedArtistName || null,
      selectedArtistKey: null,
      focusNeighborLimit: DEFAULT_FOCUS_NEIGHBOR_LIMIT
    })
  },
  setSelectedArtistKey: (selectedArtistKey) => set({ selectedArtistKey }),
  setEdgeWeightThreshold: (edgeWeightThreshold) => set({
    edgeWeightThreshold: Math.max(1, Math.round(edgeWeightThreshold))
  }),
  expandFocusNeighbors: () => set((state) => ({
    focusNeighborLimit: state.focusNeighborLimit + FOCUS_NEIGHBOR_INCREMENT
  })),
  resetFocusNeighbors: () => set({
    focusNeighborLimit: DEFAULT_FOCUS_NEIGHBOR_LIMIT
  })
}))
