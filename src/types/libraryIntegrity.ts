export type IntegrityScanMode = 'quick' | 'deep' | 'duplicates'

export type IntegrityScanScope =
  | { type: 'all' }
  | { type: 'folder'; folderPath: string }
  | { type: 'track'; trackPath: string }
  | { type: 'tracks'; trackPaths: string[] }

export type IntegrityFindingSeverity = 'error' | 'warning' | 'info'
export type IntegrityFindingConfidence = 'low' | 'medium' | 'high'
export type IntegrityDuplicateEvidence = 'exact' | 'possible' | 'mixed'

export interface IntegrityDuplicateMember {
  path: string
  title: string
  artist: string
  album: string
  duration: number
  format: string
  sizeBytes: number
  bitrate: number | null
  sampleRate: number | null
  bitDepth: number | null
  channels: number | null
  withinScope: boolean
  exactSetId?: string
}

export interface IntegrityDuplicateGroup {
  id: string
  evidence: IntegrityDuplicateEvidence
  members: IntegrityDuplicateMember[]
}

export interface IntegrityFinding {
  id: string
  severity: IntegrityFindingSeverity
  code: string
  path: string
  title?: string
  message: string
  detail?: string
  confidence?: IntegrityFindingConfidence
}

export interface IntegrityScanProgress {
  mode: IntegrityScanMode
  scope: IntegrityScanScope
  current: number
  total: number
  filePath: string
  message: string
  phase: 'preparing' | 'quick' | 'deep' | 'quality' | 'duplicates' | 'complete' | 'canceled'
}

export interface IntegrityScanSummary {
  mode: IntegrityScanMode
  scope: IntegrityScanScope
  scanned: number
  skipped: number
  errors: number
  warnings: number
  info: number
  duplicateGroups: number
  duplicateFiles: number
  exactDuplicateGroups: number
  possibleDuplicateGroups: number
  mixedDuplicateGroups: number
  canceled: boolean
  startedAt: number
  completedAt: number
}

export interface IntegrityScanResult {
  runId: string
  summary: IntegrityScanSummary
  findings: IntegrityFinding[]
  duplicateGroups: IntegrityDuplicateGroup[]
}

export interface IntegrityDuplicateTrashAction {
  groupId: string
  keepPath: string
  trashPaths: string[]
}

export interface IntegrityDuplicateTrashRequest {
  runId: string
  actions: IntegrityDuplicateTrashAction[]
}

export type IntegrityDuplicateTrashOutcomeStatus =
  | 'trashed'
  | 'failed'
  | 'trashed_merge_failed'

export interface IntegrityDuplicateTrashOutcome {
  path: string
  keepPath: string
  status: IntegrityDuplicateTrashOutcomeStatus
  error?: string
}

export interface IntegrityDuplicateTrashResult {
  runId: string
  stale: boolean
  error?: string
  outcomes: IntegrityDuplicateTrashOutcome[]
  replacements: Record<string, string>
  remainingGroups: IntegrityDuplicateGroup[]
}
