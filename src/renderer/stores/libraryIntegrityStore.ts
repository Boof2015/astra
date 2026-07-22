import { create } from 'zustand'
import type {
  IntegrityDuplicateGroup,
  IntegrityDuplicateTrashAction,
  IntegrityDuplicateTrashResult,
  IntegrityFinding,
  IntegrityFindingSeverity,
  IntegrityScanMode,
  IntegrityScanProgress,
  IntegrityScanResult,
  IntegrityScanScope
} from '../../types/libraryIntegrity'

export type IntegrityReportFilter = IntegrityFindingSeverity | 'all'

export const LIBRARY_INTEGRITY_ENABLED_STORAGE_KEY = 'astra-experimental-library-integrity-enabled-v1'

function readEnabledPreference(): boolean {
  try {
    return localStorage.getItem(LIBRARY_INTEGRITY_ENABLED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function persistEnabledPreference(enabled: boolean): void {
  try {
    localStorage.setItem(LIBRARY_INTEGRITY_ENABLED_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // Keep the in-memory setting if localStorage is unavailable.
  }
}

function sameFinding(a: IntegrityFinding, b: IntegrityFinding): boolean {
  return a.id === b.id
}

interface LibraryIntegrityStore {
  enabled: boolean
  isPanelOpen: boolean
  mode: IntegrityScanMode
  selectedScope: IntegrityScanScope
  filter: IntegrityReportFilter
  isScanning: boolean
  isCanceling: boolean
  progress: IntegrityScanProgress | null
  findings: IntegrityFinding[]
  duplicateGroups: IntegrityDuplicateGroup[]
  result: IntegrityScanResult | null
  errorMessage: string
  singleTrackResult: IntegrityScanResult | null
  singleTrackBusyPath: string | null
  singleTrackBusyPaths: string[]
  singleTrackError: string
  isTrashingDuplicates: boolean
  duplicateTrashResult: IntegrityDuplicateTrashResult | null
  duplicateTrashError: string
  setEnabled: (enabled: boolean) => void
  openPanel: () => void
  closePanel: () => void
  setMode: (mode: IntegrityScanMode) => void
  setSelectedScope: (scope: IntegrityScanScope) => void
  setFilter: (filter: IntegrityReportFilter) => void
  clearReport: () => void
  startScan: () => Promise<void>
  cancelScan: () => Promise<boolean>
  trashDuplicates: (actions: IntegrityDuplicateTrashAction[]) => Promise<IntegrityDuplicateTrashResult | null>
  checkTrack: (trackPath: string) => Promise<void>
  checkTracks: (trackPaths: string[]) => Promise<void>
  closeSingleTrackResult: () => void
}

let integrityListenersAttached = false

function ensureIntegrityListeners(): void {
  if (integrityListenersAttached) return
  integrityListenersAttached = true

  window.electronAPI.library.onIntegrityScanProgress((progress) => {
    useLibraryIntegrityStore.setState({ progress })
  })

  window.electronAPI.library.onIntegrityScanFinding((finding) => {
    useLibraryIntegrityStore.setState((state) => {
      if (state.findings.some((existing) => sameFinding(existing, finding))) return state
      return { findings: [...state.findings, finding] }
    })
  })

  window.electronAPI.library.onIntegrityScanComplete((result) => {
    useLibraryIntegrityStore.setState({
      result,
      findings: result.findings,
      duplicateGroups: result.duplicateGroups,
      isScanning: false,
      isCanceling: false,
      progress: {
        mode: result.summary.mode,
        scope: result.summary.scope,
        current: result.summary.scanned,
        total: result.summary.scanned + result.summary.skipped,
        filePath: '',
        message: result.summary.canceled ? 'Integrity scan canceled.' : 'Integrity scan complete.',
        phase: result.summary.canceled ? 'canceled' : 'complete'
      }
    })
  })
}

export const useLibraryIntegrityStore = create<LibraryIntegrityStore>((set, get) => ({
  enabled: readEnabledPreference(),
  isPanelOpen: false,
  mode: 'quick',
  selectedScope: { type: 'all' },
  filter: 'all',
  isScanning: false,
  isCanceling: false,
  progress: null,
  findings: [],
  duplicateGroups: [],
  result: null,
  errorMessage: '',
  singleTrackResult: null,
  singleTrackBusyPath: null,
  singleTrackBusyPaths: [],
  singleTrackError: '',
  isTrashingDuplicates: false,
  duplicateTrashResult: null,
  duplicateTrashError: '',

  setEnabled: (enabled) => {
    const normalized = Boolean(enabled)
    persistEnabledPreference(normalized)
    set({
      enabled: normalized,
      isPanelOpen: normalized ? get().isPanelOpen : false
    })
  },

  openPanel: () => {
    ensureIntegrityListeners()
    set({ isPanelOpen: true })
  },

  closePanel: () => set({ isPanelOpen: false }),

  setMode: (mode) => set({ mode }),

  setSelectedScope: (selectedScope) => set({ selectedScope }),

  setFilter: (filter) => set({ filter }),

  clearReport: () => set({
    progress: null,
    findings: [],
    duplicateGroups: [],
    result: null,
    errorMessage: '',
    duplicateTrashResult: null,
    duplicateTrashError: ''
  }),

  startScan: async () => {
    ensureIntegrityListeners()
    const { mode, selectedScope } = get()
    set({
      isScanning: true,
      isCanceling: false,
      progress: null,
      findings: [],
      duplicateGroups: [],
      result: null,
      errorMessage: '',
      duplicateTrashResult: null,
      duplicateTrashError: ''
    })

    try {
      const result = await window.electronAPI.library.startIntegrityScan({ mode, scope: selectedScope })
      set({
        result,
        findings: result.findings,
        duplicateGroups: result.duplicateGroups,
        isScanning: false,
        isCanceling: false
      })
    } catch (error) {
      set({
        isScanning: false,
        isCanceling: false,
        errorMessage: error instanceof Error ? error.message : 'Integrity scan failed.'
      })
    }
  },

  cancelScan: async () => {
    if (!get().isScanning) return false
    set({ isCanceling: true })
    try {
      const result = await window.electronAPI.library.cancelIntegrityScan()
      if (!result.canceled) {
        set({ isCanceling: false })
      }
      return result.canceled
    } catch (error) {
      set({
        isCanceling: false,
        errorMessage: error instanceof Error ? error.message : 'Could not cancel integrity scan.'
      })
      return false
    }
  },

  trashDuplicates: async (actions) => {
    const result = get().result
    if (!result || result.summary.mode !== 'duplicates' || actions.length === 0) return null
    set({ isTrashingDuplicates: true, duplicateTrashResult: null, duplicateTrashError: '' })
    try {
      const trashResult = await window.electronAPI.library.trashIntegrityDuplicates({
        runId: result.runId,
        actions
      })
      const duplicateGroups = trashResult.remainingGroups
      const duplicateFiles = new Set(duplicateGroups.flatMap((group) => group.members.map((member) => member.path))).size
      const updatedResult: IntegrityScanResult = {
        ...result,
        duplicateGroups,
        summary: {
          ...result.summary,
          duplicateGroups: duplicateGroups.length,
          duplicateFiles,
          exactDuplicateGroups: duplicateGroups.filter((group) => group.evidence === 'exact').length,
          possibleDuplicateGroups: duplicateGroups.filter((group) => group.evidence === 'possible').length,
          mixedDuplicateGroups: duplicateGroups.filter((group) => group.evidence === 'mixed').length
        }
      }
      set({
        isTrashingDuplicates: false,
        duplicateTrashResult: trashResult,
        duplicateTrashError: trashResult.error ?? '',
        duplicateGroups,
        result: updatedResult
      })
      return trashResult
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not move duplicate files to Trash.'
      set({ isTrashingDuplicates: false, duplicateTrashError: message })
      return null
    }
  },

  checkTrack: async (trackPath) => {
    await get().checkTracks([trackPath])
  },

  checkTracks: async (trackPaths) => {
    const normalizedTrackPaths = Array.from(new Set(
      trackPaths
        .map((trackPath) => (typeof trackPath === 'string' ? trackPath.trim() : ''))
        .filter((trackPath) => trackPath.length > 0)
    ))
    set({
      singleTrackBusyPath: normalizedTrackPaths[0] ?? null,
      singleTrackBusyPaths: normalizedTrackPaths,
      singleTrackResult: null,
      singleTrackError: ''
    })
    try {
      const result = normalizedTrackPaths.length === 1
        ? await window.electronAPI.library.checkTrackIntegrity(normalizedTrackPaths[0])
        : await window.electronAPI.library.checkTracksIntegrity(normalizedTrackPaths)
      set({
        singleTrackResult: result,
        singleTrackBusyPath: null,
        singleTrackBusyPaths: []
      })
    } catch (error) {
      set({
        singleTrackBusyPath: null,
        singleTrackBusyPaths: [],
        singleTrackError: error instanceof Error ? error.message : 'Track integrity check failed.'
      })
    }
  },

  closeSingleTrackResult: () => set({
    singleTrackResult: null,
    singleTrackBusyPaths: [],
    singleTrackError: ''
  })
}))
