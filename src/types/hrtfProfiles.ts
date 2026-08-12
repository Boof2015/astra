export const BUILTIN_HRTF_PROFILE_ID = 'builtin:mit-kemar'
export const BUILTIN_HRTF_PROFILE_NAME = 'MIT KEMAR'
export const HRTF_PROFILE_MAX_BYTES = 64 * 1024 * 1024
export const HRTF_PROFILE_MAX_TAPS = 8192

export type HrtfProfileKind = 'builtin' | 'sofa'

export interface HrtfProfileSummary {
  id: string
  name: string
  kind: HrtfProfileKind
  importedAt: string | null
  sizeBytes: number | null
}

// A selection carries the same stable, renderer-ready metadata returned by
// the managed library; profile bytes remain behind the narrow read API.
export type HrtfProfileSelection = HrtfProfileSummary

export interface HrtfProfileCandidate {
  fileName: string
  sizeBytes: number
  bytes: ArrayBuffer
}

export type HrtfProfileErrorCode =
  | 'cancelled'
  | 'invalid-extension'
  | 'file-too-large'
  | 'invalid-sofa'
  | 'unsupported-sofa'
  | 'filter-too-long'
  | 'out-of-memory'
  | 'not-found'
  | 'storage-error'
  | 'renderer-error'
  | 'unsupported-samplerate'

export interface HrtfProfileError {
  code: HrtfProfileErrorCode
  message: string
}

export type HrtfProfileValidationError = HrtfProfileError & {
  code:
    | 'invalid-sofa'
    | 'unsupported-sofa'
    | 'filter-too-long'
    | 'out-of-memory'
    | 'renderer-error'
    | 'unsupported-samplerate'
}

export type HrtfProfileCandidateResult =
  | { ok: true; candidate: HrtfProfileCandidate }
  | { ok: false; error: HrtfProfileError }

export type HrtfProfileCommitResult =
  | { ok: true; profile: HrtfProfileSummary; duplicate: boolean }
  | { ok: false; error: HrtfProfileError }

export type HrtfProfileImportResult = HrtfProfileCommitResult

export type HrtfProfileBytesResult =
  | { ok: true; bytes: ArrayBuffer }
  | { ok: false; error: HrtfProfileError }

export type HrtfProfileRemoveResult =
  | { ok: true }
  | { ok: false; error: HrtfProfileError }

export function builtinHrtfProfile(): HrtfProfileSummary {
  return {
    id: BUILTIN_HRTF_PROFILE_ID,
    name: BUILTIN_HRTF_PROFILE_NAME,
    kind: 'builtin',
    importedAt: null,
    sizeBytes: null,
  }
}
