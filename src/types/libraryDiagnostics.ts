export const LIBRARY_DIAGNOSTICS_SCHEMA_VERSION = 1

export interface LibraryDiagnosticsStatus {
  enabled: boolean
  schemaVersion: number
  currentLogPath: string
  previousLogPath: string
  hasCurrentLog: boolean
  hasPreviousLog: boolean
  sessionStartedAt: number | null
}

export type LibraryDiagnosticsOperationKind =
  | 'add_folder'
  | 'rescan_folder'
  | 'rescan_all'
  | 'force_rescan_all'
  | 'remove_folder'

export type LibraryReloadStep =
  | 'track_count'
  | 'track_duration'
  | 'albums'
  | 'albums_including_singles'
  | 'artists'
  | 'genres'
  | 'folders'
  | 'favorites'
  | 'recently_played'
  | 'full_tracks'
  | 'active_selection'

export interface LibraryDiagnosticsRendererTimingEvent {
  runId: string
  operationKind: LibraryDiagnosticsOperationKind
  backendDurationMs: number
  reloadDurationMs: number
  totalDurationMs: number
  stepDurationMs: Partial<Record<LibraryReloadStep, number>>
  stepRequestCount: Partial<Record<LibraryReloadStep, number>>
  stepResultCount: Partial<Record<LibraryReloadStep, number>>
}
