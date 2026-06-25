import {
  ACTIVITY_INDICATOR_EXPERIMENT_STORAGE_KEY,
  ANALYZER_PROFILES_STORAGE_KEY,
  ANALYZER_HEIGHT_STORAGE_KEY,
  ANALYZER_RACK_VISIBILITY_STORAGE_KEY,
  ARTIST_BROWSE_MODE_STORAGE_KEY,
  AUDIO_OUTPUT_DEVICE_STORAGE_KEY,
  BIT_PERFECT_WARNING_DISMISSED_STORAGE_KEY,
  CALIBRATION_INPUT_STORAGE_KEY,
  CHANNEL_ROUTING_STORAGE_KEY,
  CONTROLLER_SUPPORT_EXPERIMENT_STORAGE_KEY,
  DELAY_PROFILE_STORAGE_KEY_V1,
  DELAY_PROFILE_STORAGE_KEY_V2,
  DEVELOPER_SETTINGS_VISIBILITY_STORAGE_KEY,
  DEV_DISABLE_GAPLESS_PREBUFFER_STORAGE_KEY,
  DEV_DISABLE_STANDARD_ANALYSIS_GRAPH_STORAGE_KEY,
  DISCORD_COVER_ART_CACHE_STORAGE_KEY_V1,
  DISCORD_COVER_ART_CACHE_STORAGE_KEY_V2,
  DISCORD_COVER_ART_CACHE_STORAGE_KEY_V3,
  DISCORD_COVER_ART_CACHE_STORAGE_KEY_V4,
  DISCORD_LEGACY_CLIENT_ID_STORAGE_KEY,
  DISCORD_RPC_COMPACT_STATUS_MODE_STORAGE_KEY,
  DISCORD_RPC_COVER_ART_ENABLED_STORAGE_KEY,
  DISCORD_RPC_ENABLED_STORAGE_KEY,
  DISCORD_RPC_EXPANDED_INFO_MODE_STORAGE_KEY,
  DISCORD_RPC_LINK_DESTINATION_STORAGE_KEY,
  DISCORD_RPC_PAUSE_CLEAR_MINUTES_STORAGE_KEY,
  DISCORD_RPC_SMALL_ICON_ENABLED_STORAGE_KEY,
  EQ_DEVICE_PROFILE_STORAGE_KEY,
  EQ_STORAGE_KEY,
  GLOBAL_INPUT_BINDINGS_STORAGE_KEY,
  HOME_GREETING_TEXT_MODE_STORAGE_KEY,
  INCLUDE_LFE_DOWNMIX_STORAGE_KEY,
  INPUT_BINDINGS_STORAGE_KEY,
  JUMP_TO_PLAYING_DESTINATION_STORAGE_KEY,
  LIBRARY_GRAPH_ENABLED_STORAGE_KEY,
  LIBRARY_INTEGRITY_ENABLED_STORAGE_KEY,
  LYRICS_DISPLAY_SETTINGS_STORAGE_KEY,
  MULTICHANNEL_STORAGE_KEY,
  NATIVE_AUDIO_OUTPUT_DEVICE_STORAGE_KEY,
  NORMALIZATION_ENABLED_STORAGE_KEY,
  NORMALIZATION_TARGET_STORAGE_KEY,
  OSCILLOSCOPE_UNDERFILL_STORAGE_KEY,
  PLAYBACK_OUTPUT_MODE_STORAGE_KEY,
  PLAYER_VOLUME_STORAGE_KEY,
  REPLAYGAIN_MODE_STORAGE_KEY,
  SPECTRUM_HEATMAP_STORAGE_KEY,
  STEREO_UPMIX_MODE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  TRACKLIST_ADDED_DATE_VISIBILITY_STORAGE_KEY,
  TRACKLIST_BPM_KEY_VISIBILITY_STORAGE_KEY,
  UI_SCALE_STORAGE_KEY,
  UPDATES_AUTO_CHECK_STORAGE_KEY,
  VECTORSCOPE_MULTIBAND_STORAGE_KEY,
  WAVEFORM_MULTIBAND_STORAGE_KEY,
  WAVEFORM_TIME_DISPLAY_MODE_STORAGE_KEY,
} from '../constants/settingsStorageKeys'

export const SETTINGS_TRANSFER_KIND = 'astra-settings-transfer'
export const SETTINGS_TRANSFER_SCHEMA_VERSION = 1

export const SETTINGS_TRANSFER_CATEGORY_IDS = [
  'appearance',
  'interface',
  'library_view',
  'analyzer_profiles',
  'eq_presets',
  'playback_audio',
  'keybinds',
  'non_secret_integrations',
  'experiments',
] as const

export type SettingsTransferCategoryId = (typeof SETTINGS_TRANSFER_CATEGORY_IDS)[number]

export interface SettingsTransferCategoryDefinition {
  id: SettingsTransferCategoryId
  label: string
  description: string
}

export interface SettingsTransferCategoryPayload {
  localStorage: Record<string, string>
  values?: Record<string, unknown>
}

export interface AstraSettingsTransferFile {
  kind: typeof SETTINGS_TRANSFER_KIND
  schemaVersion: typeof SETTINGS_TRANSFER_SCHEMA_VERSION
  exportedAt: string
  appVersion: string | null
  categories: Partial<Record<SettingsTransferCategoryId, SettingsTransferCategoryPayload>>
}

export type SettingsTransferParseResult =
  | { ok: true; file: AstraSettingsTransferFile }
  | { ok: false; error: string }

export type SettingsTransferApplyResult =
  | { ok: true; importedCategoryIds: SettingsTransferCategoryId[] }
  | { ok: false; error: string }

export interface SettingsTransferStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export interface CreateSettingsTransferOptions {
  storage?: SettingsTransferStorage
  appVersion?: string | null
  exportedAt?: string
  lyricsOnlineEnabled?: boolean
}

export interface ApplySettingsTransferOptions {
  storage?: SettingsTransferStorage
  setLyricsOnlineEnabled?: (enabled: boolean) => Promise<void> | void
}

const SETTINGS_TRANSFER_CATEGORY_DEFINITIONS_INTERNAL: SettingsTransferCategoryDefinition[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Theme, accent color, and cover-art accent behavior.',
  },
  {
    id: 'interface',
    label: 'Interface',
    description: 'UI scale, home greeting, analyzer rack layout, and navigation preferences.',
  },
  {
    id: 'library_view',
    label: 'Library View',
    description: 'Artist browse mode and visible tracklist columns.',
  },
  {
    id: 'analyzer_profiles',
    label: 'Analyzer Profiles',
    description: 'Scope rack profiles, active profile, scope order, hidden scopes, widths, and scope options.',
  },
  {
    id: 'eq_presets',
    label: 'EQ Presets',
    description: 'Custom equalizer presets, without device assignments.',
  },
  {
    id: 'playback_audio',
    label: 'Playback Audio',
    description: 'Volume, normalization, normalization target, and ReplayGain mode.',
  },
  {
    id: 'keybinds',
    label: 'Keybinds',
    description: 'Local keyboard and mouse shortcut overrides.',
  },
  {
    id: 'non_secret_integrations',
    label: 'Non-secret Integrations',
    description: 'Discord display preferences, lyrics lookup/display preferences, and update checks.',
  },
  {
    id: 'experiments',
    label: 'Experiments',
    description: 'Portable experimental feature toggles.',
  },
]

export const SETTINGS_TRANSFER_CATEGORY_DEFINITIONS = SETTINGS_TRANSFER_CATEGORY_DEFINITIONS_INTERNAL

export const SETTINGS_TRANSFER_CATEGORY_STORAGE_KEYS: Record<SettingsTransferCategoryId, readonly string[]> = {
  appearance: [
    THEME_STORAGE_KEY,
  ],
  interface: [
    UI_SCALE_STORAGE_KEY,
    HOME_GREETING_TEXT_MODE_STORAGE_KEY,
    ANALYZER_HEIGHT_STORAGE_KEY,
    ANALYZER_RACK_VISIBILITY_STORAGE_KEY,
    JUMP_TO_PLAYING_DESTINATION_STORAGE_KEY,
    WAVEFORM_TIME_DISPLAY_MODE_STORAGE_KEY,
  ],
  library_view: [
    ARTIST_BROWSE_MODE_STORAGE_KEY,
    TRACKLIST_BPM_KEY_VISIBILITY_STORAGE_KEY,
    TRACKLIST_ADDED_DATE_VISIBILITY_STORAGE_KEY,
  ],
  analyzer_profiles: [
    ANALYZER_PROFILES_STORAGE_KEY,
    OSCILLOSCOPE_UNDERFILL_STORAGE_KEY,
    VECTORSCOPE_MULTIBAND_STORAGE_KEY,
    WAVEFORM_MULTIBAND_STORAGE_KEY,
    SPECTRUM_HEATMAP_STORAGE_KEY,
  ],
  eq_presets: [
    EQ_STORAGE_KEY,
  ],
  playback_audio: [
    PLAYER_VOLUME_STORAGE_KEY,
    NORMALIZATION_ENABLED_STORAGE_KEY,
    NORMALIZATION_TARGET_STORAGE_KEY,
    REPLAYGAIN_MODE_STORAGE_KEY,
  ],
  keybinds: [
    INPUT_BINDINGS_STORAGE_KEY,
  ],
  non_secret_integrations: [
    DISCORD_RPC_ENABLED_STORAGE_KEY,
    DISCORD_RPC_COVER_ART_ENABLED_STORAGE_KEY,
    DISCORD_RPC_SMALL_ICON_ENABLED_STORAGE_KEY,
    DISCORD_RPC_COMPACT_STATUS_MODE_STORAGE_KEY,
    DISCORD_RPC_EXPANDED_INFO_MODE_STORAGE_KEY,
    DISCORD_RPC_LINK_DESTINATION_STORAGE_KEY,
    DISCORD_RPC_PAUSE_CLEAR_MINUTES_STORAGE_KEY,
    LYRICS_DISPLAY_SETTINGS_STORAGE_KEY,
    UPDATES_AUTO_CHECK_STORAGE_KEY,
  ],
  experiments: [
    LIBRARY_GRAPH_ENABLED_STORAGE_KEY,
    LIBRARY_INTEGRITY_ENABLED_STORAGE_KEY,
    CONTROLLER_SUPPORT_EXPERIMENT_STORAGE_KEY,
    ACTIVITY_INDICATOR_EXPERIMENT_STORAGE_KEY,
  ],
}

export const SETTINGS_TRANSFER_EXCLUDED_STORAGE_KEYS = [
  GLOBAL_INPUT_BINDINGS_STORAGE_KEY,
  AUDIO_OUTPUT_DEVICE_STORAGE_KEY,
  NATIVE_AUDIO_OUTPUT_DEVICE_STORAGE_KEY,
  PLAYBACK_OUTPUT_MODE_STORAGE_KEY,
  CALIBRATION_INPUT_STORAGE_KEY,
  MULTICHANNEL_STORAGE_KEY,
  INCLUDE_LFE_DOWNMIX_STORAGE_KEY,
  STEREO_UPMIX_MODE_STORAGE_KEY,
  CHANNEL_ROUTING_STORAGE_KEY,
  DELAY_PROFILE_STORAGE_KEY_V1,
  DELAY_PROFILE_STORAGE_KEY_V2,
  EQ_DEVICE_PROFILE_STORAGE_KEY,
  DEV_DISABLE_GAPLESS_PREBUFFER_STORAGE_KEY,
  DEV_DISABLE_STANDARD_ANALYSIS_GRAPH_STORAGE_KEY,
  DISCORD_COVER_ART_CACHE_STORAGE_KEY_V1,
  DISCORD_COVER_ART_CACHE_STORAGE_KEY_V2,
  DISCORD_COVER_ART_CACHE_STORAGE_KEY_V3,
  DISCORD_COVER_ART_CACHE_STORAGE_KEY_V4,
  DISCORD_LEGACY_CLIENT_ID_STORAGE_KEY,
  DEVELOPER_SETTINGS_VISIBILITY_STORAGE_KEY,
  BIT_PERFECT_WARNING_DISMISSED_STORAGE_KEY,
] as const

const CATEGORY_ID_SET = new Set<string>(SETTINGS_TRANSFER_CATEGORY_IDS)

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function resolveStorage(storage?: SettingsTransferStorage): SettingsTransferStorage {
  if (storage) return storage
  if (typeof localStorage !== 'undefined') return localStorage
  throw new Error('Settings transfer storage is unavailable.')
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function normalizeCategorySelection(categoryIds: readonly SettingsTransferCategoryId[]): SettingsTransferCategoryId[] {
  const out: SettingsTransferCategoryId[] = []
  for (const categoryId of categoryIds) {
    if (!CATEGORY_ID_SET.has(categoryId)) continue
    if (out.includes(categoryId)) continue
    out.push(categoryId)
  }
  return out
}

function collectLocalStorageValues(
  storage: SettingsTransferStorage,
  storageKeys: readonly string[]
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of storageKeys) {
    const value = storage.getItem(key)
    if (value !== null) {
      out[key] = value
    }
  }
  return out
}

function normalizeCategoryPayload(value: unknown): SettingsTransferCategoryPayload {
  if (!isPlainRecord(value)) {
    return { localStorage: {} }
  }

  const localStorageRecord: Record<string, string> = {}
  if (isPlainRecord(value.localStorage)) {
    for (const [key, rawStoredValue] of Object.entries(value.localStorage)) {
      if (typeof rawStoredValue === 'string') {
        localStorageRecord[key] = rawStoredValue
      }
    }
  }

  const values = isPlainRecord(value.values)
    ? { ...value.values }
    : undefined

  return values
    ? { localStorage: localStorageRecord, values }
    : { localStorage: localStorageRecord }
}

function buildCategoryPayload(
  categoryId: SettingsTransferCategoryId,
  options: Required<Pick<CreateSettingsTransferOptions, 'storage'>> & CreateSettingsTransferOptions
): SettingsTransferCategoryPayload {
  const payload: SettingsTransferCategoryPayload = {
    localStorage: collectLocalStorageValues(options.storage, SETTINGS_TRANSFER_CATEGORY_STORAGE_KEYS[categoryId]),
  }

  if (categoryId === 'non_secret_integrations') {
    payload.values = {
      lyricsOnlineEnabled: Boolean(options.lyricsOnlineEnabled),
    }
  }

  return payload
}

export function isSettingsTransferCategoryId(value: unknown): value is SettingsTransferCategoryId {
  return typeof value === 'string' && CATEGORY_ID_SET.has(value)
}

export function getSettingsTransferCategoryDefinition(
  categoryId: SettingsTransferCategoryId
): SettingsTransferCategoryDefinition {
  return SETTINGS_TRANSFER_CATEGORY_DEFINITIONS.find((definition) => definition.id === categoryId)!
}

export function getSettingsTransferCategoryStorageKeys(
  categoryId: SettingsTransferCategoryId
): readonly string[] {
  return SETTINGS_TRANSFER_CATEGORY_STORAGE_KEYS[categoryId]
}

export function getImportableSettingsTransferCategoryIds(
  file: AstraSettingsTransferFile
): SettingsTransferCategoryId[] {
  return SETTINGS_TRANSFER_CATEGORY_IDS.filter((categoryId) => hasOwn(file.categories, categoryId))
}

export function createSettingsTransferFile(
  categoryIds: readonly SettingsTransferCategoryId[],
  options: CreateSettingsTransferOptions = {}
): AstraSettingsTransferFile {
  const storage = resolveStorage(options.storage)
  const categories: Partial<Record<SettingsTransferCategoryId, SettingsTransferCategoryPayload>> = {}

  for (const categoryId of normalizeCategorySelection(categoryIds)) {
    categories[categoryId] = buildCategoryPayload(categoryId, {
      ...options,
      storage,
    })
  }

  return {
    kind: SETTINGS_TRANSFER_KIND,
    schemaVersion: SETTINGS_TRANSFER_SCHEMA_VERSION,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    appVersion: options.appVersion ?? null,
    categories,
  }
}

export function serializeSettingsTransferFile(file: AstraSettingsTransferFile): string {
  return JSON.stringify(file, null, 2)
}

export function parseSettingsTransferFile(content: string): SettingsTransferParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { ok: false, error: 'This is not a valid settings transfer file.' }
  }

  if (!isPlainRecord(parsed)) {
    return { ok: false, error: 'This is not a valid settings transfer file.' }
  }

  if (parsed.kind !== SETTINGS_TRANSFER_KIND) {
    return { ok: false, error: 'This file was not exported by Astra settings transfer.' }
  }

  if (parsed.schemaVersion !== SETTINGS_TRANSFER_SCHEMA_VERSION) {
    return { ok: false, error: 'This settings transfer file uses an unsupported version.' }
  }

  if (!isPlainRecord(parsed.categories)) {
    return { ok: false, error: 'This settings transfer file does not include any categories.' }
  }

  const categories: Partial<Record<SettingsTransferCategoryId, SettingsTransferCategoryPayload>> = {}
  for (const categoryId of SETTINGS_TRANSFER_CATEGORY_IDS) {
    if (!hasOwn(parsed.categories, categoryId)) continue
    categories[categoryId] = normalizeCategoryPayload(parsed.categories[categoryId])
  }

  return {
    ok: true,
    file: {
      kind: SETTINGS_TRANSFER_KIND,
      schemaVersion: SETTINGS_TRANSFER_SCHEMA_VERSION,
      exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
      appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : null,
      categories,
    },
  }
}

export async function applySettingsTransferFile(
  file: AstraSettingsTransferFile,
  categoryIds: readonly SettingsTransferCategoryId[],
  options: ApplySettingsTransferOptions = {}
): Promise<SettingsTransferApplyResult> {
  const storage = resolveStorage(options.storage)
  const importedCategoryIds: SettingsTransferCategoryId[] = []

  try {
    for (const categoryId of normalizeCategorySelection(categoryIds)) {
      if (!hasOwn(file.categories, categoryId)) continue

      const payload = normalizeCategoryPayload(file.categories[categoryId])
      const allowedKeys = new Set(SETTINGS_TRANSFER_CATEGORY_STORAGE_KEYS[categoryId])

      for (const key of allowedKeys) {
        storage.removeItem(key)
      }

      for (const [key, value] of Object.entries(payload.localStorage)) {
        if (allowedKeys.has(key)) {
          storage.setItem(key, value)
        }
      }

      if (categoryId === 'non_secret_integrations' && options.setLyricsOnlineEnabled) {
        await options.setLyricsOnlineEnabled(payload.values?.lyricsOnlineEnabled === true)
      }

      importedCategoryIds.push(categoryId)
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error && error.message.trim()
        ? error.message
        : 'Failed to import settings.',
    }
  }

  return { ok: true, importedCategoryIds }
}
