export type IntegrityScanMode = 'quick' | 'deep'

export type IntegrityScanScope =
  | { type: 'all' }
  | { type: 'folder'; folderPath: string }
  | { type: 'track'; trackPath: string }
  | { type: 'tracks'; trackPaths: string[] }

export type IntegrityFindingSeverity = 'error' | 'warning' | 'info'
export type IntegrityFindingConfidence = 'low' | 'medium' | 'high'

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
  phase: 'preparing' | 'quick' | 'deep' | 'quality' | 'complete' | 'canceled'
}

export interface IntegrityScanSummary {
  mode: IntegrityScanMode
  scope: IntegrityScanScope
  scanned: number
  skipped: number
  errors: number
  warnings: number
  info: number
  canceled: boolean
  startedAt: number
  completedAt: number
}

export interface IntegrityScanResult {
  summary: IntegrityScanSummary
  findings: IntegrityFinding[]
}
