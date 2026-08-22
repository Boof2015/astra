export const BUILTIN_HRTF_PROFILE_ID = 'builtin:mit-kemar'
export const BUILTIN_HRTF_PROFILE_NAME = 'MIT KEMAR'
export const SADIE_II_D1_KU100_HRTF_PROFILE_ID = 'builtin:sadie-ii-d1-ku100'
export const SOUND_SPHERE_2_AKO_HRTF_PROFILE_ID = 'builtin:sound-sphere-2-ako'
export const HRTF_PROFILE_MAX_BYTES = 64 * 1024 * 1024
export const HRTF_PROFILE_MAX_TAPS = 8192

export type HrtfProfileKind = 'builtin' | 'sofa'

export interface HrtfProfileSummary {
  id: string
  name: string
  kind: HrtfProfileKind
  builtIn: boolean
  importedAt: string | null
  sizeBytes: number | null
}

export interface BuiltinSofaHrtfProfileDefinition extends HrtfProfileSummary {
  kind: 'sofa'
  builtIn: true
  importedAt: null
  sizeBytes: number
  assetFileName: string
  sha256: string
}

export const BUILTIN_SOFA_HRTF_PROFILES: readonly BuiltinSofaHrtfProfileDefinition[] = [
  {
    id: SADIE_II_D1_KU100_HRTF_PROFILE_ID,
    name: 'SADIE II D1 (KU100)',
    kind: 'sofa',
    builtIn: true,
    importedAt: null,
    sizeBytes: 36_591_729,
    assetFileName: 'sadie-ii-d1-ku100.sofa',
    sha256: 'e6c72a84dd947b5ef75438ab96a9c2a32ed10f033472b9c4c11a49aff00a8a31',
  },
  {
    id: SOUND_SPHERE_2_AKO_HRTF_PROFILE_ID,
    name: 'Sound Sphere 2 (AKO)',
    kind: 'sofa',
    builtIn: true,
    importedAt: null,
    sizeBytes: 8_912_056,
    assetFileName: 'sound-sphere-2-ako.sofa',
    sha256: '0d96f1b4cb599a59ac51b7074e3dc3473b1f549723685ef365d6643293a0f21e',
  },
]

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
    builtIn: true,
    importedAt: null,
    sizeBytes: null,
  }
}

export function builtinHrtfProfiles(): HrtfProfileSummary[] {
  return [
    builtinHrtfProfile(),
    ...BUILTIN_SOFA_HRTF_PROFILES.map(({ assetFileName: _assetFileName, sha256: _sha256, ...profile }) => ({
      ...profile,
    })),
  ]
}
