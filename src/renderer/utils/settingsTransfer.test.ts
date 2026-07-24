import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EQ_DEVICE_PROFILE_STORAGE_KEY,
  EQ_STORAGE_KEY,
  GLOBAL_INPUT_BINDINGS_STORAGE_KEY,
  HOME_GREETING_TEXT_MODE_STORAGE_KEY,
  INPUT_BINDINGS_STORAGE_KEY,
  LYRICS_DISPLAY_SETTINGS_STORAGE_KEY,
  LISTENING_STATS_ENABLED_STORAGE_KEY,
  NORMALIZATION_ENABLED_STORAGE_KEY,
  THEME_STORAGE_KEY,
  TRACKLIST_PLAY_COUNT_VISIBILITY_STORAGE_KEY,
  TRANSPORT_INFO_LINE_MODE_STORAGE_KEY,
  UI_SCALE_STORAGE_KEY,
} from '../constants/settingsStorageKeys.ts'
import {
  DEFAULT_EXPORT_SETTINGS_TRANSFER_CATEGORY_IDS,
  SETTINGS_TRANSFER_EXCLUDED_STORAGE_KEYS,
  applySettingsTransferFile,
  createSettingsTransferFile,
  getImportableSettingsTransferCategoryIds,
  parseSettingsTransferFile,
  serializeSettingsTransferFile,
  type AstraSettingsTransferFile,
  type SettingsTransferStorage,
} from './settingsTransfer.ts'
import { LRCLIB_OFFICIAL_BASE_URL } from '../../types/lyrics.ts'
import { createEmptyListeningStatsImportResult } from '../../shared/stats/statsTransfer.ts'

const emptyImportResult = createEmptyListeningStatsImportResult()

class MemoryStorage implements SettingsTransferStorage {
  private values = new Map<string, string>()

  constructor(initialValues: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initialValues)) {
      this.values.set(key, value)
    }
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function collectExportedStorageKeys(file: AstraSettingsTransferFile): string[] {
  return Object.values(file.categories).flatMap((category) => (
    category ? Object.keys(category.localStorage) : []
  ))
}

test('selected export categories include only allowlisted portable keys', () => {
  const storage = new MemoryStorage({
    [THEME_STORAGE_KEY]: '{"presetId":"crimson"}',
    [EQ_STORAGE_KEY]: '[{"name":"Custom"}]',
    [INPUT_BINDINGS_STORAGE_KEY]: '{"version":1,"overrides":{}}',
    [GLOBAL_INPUT_BINDINGS_STORAGE_KEY]: '{"version":1,"enabled":{}}',
    [EQ_DEVICE_PROFILE_STORAGE_KEY]: '{"version":1,"profiles":{}}',
    'astra-subsonic-sources-v1': 'server',
  })

  const file = createSettingsTransferFile(['appearance', 'eq_presets', 'keybinds'], {
    storage,
    appVersion: 'test',
    exportedAt: '2026-06-25T00:00:00.000Z',
  })

  assert.equal(file.categories.appearance?.localStorage[THEME_STORAGE_KEY], '{"presetId":"crimson"}')
  assert.equal(file.categories.eq_presets?.localStorage[EQ_STORAGE_KEY], '[{"name":"Custom"}]')
  assert.equal(file.categories.keybinds?.localStorage[INPUT_BINDINGS_STORAGE_KEY], '{"version":1,"overrides":{}}')

  const exportedKeys = collectExportedStorageKeys(file)
  assert.equal(exportedKeys.includes(GLOBAL_INPUT_BINDINGS_STORAGE_KEY), false)
  assert.equal(exportedKeys.includes(EQ_DEVICE_PROFILE_STORAGE_KEY), false)
  assert.equal(exportedKeys.includes('astra-subsonic-sources-v1'), false)
})

test('known machine-specific, sensitive, and cache keys are excluded from full export', () => {
  const storage = new MemoryStorage(Object.fromEntries(
    SETTINGS_TRANSFER_EXCLUDED_STORAGE_KEYS.map((key) => [key, 'sensitive-or-local'])
  ))

  const file = createSettingsTransferFile([
    'appearance',
    'interface',
    'library_view',
    'analyzer_profiles',
    'eq_presets',
    'playback_audio',
    'keybinds',
    'non_secret_integrations',
    'experiments',
  ], { storage })

  const exportedKeys = collectExportedStorageKeys(file)
  for (const key of SETTINGS_TRANSFER_EXCLUDED_STORAGE_KEYS) {
    assert.equal(exportedKeys.includes(key), false, `${key} should not be exported`)
  }
})

test('library view and experiment transfers include play count and Listening Stats preferences', () => {
  const file = createSettingsTransferFile(['library_view', 'experiments'], {
    storage: new MemoryStorage({
      [TRACKLIST_PLAY_COUNT_VISIBILITY_STORAGE_KEY]: '1',
      [LISTENING_STATS_ENABLED_STORAGE_KEY]: '1'
    })
  })

  assert.equal(
    file.categories.library_view?.localStorage[TRACKLIST_PLAY_COUNT_VISIBILITY_STORAGE_KEY],
    '1'
  )
  assert.equal(
    file.categories.experiments?.localStorage[LISTENING_STATS_ENABLED_STORAGE_KEY],
    '1'
  )
})

test('interface transfers include the transport info line preference', () => {
  const file = createSettingsTransferFile(['interface'], {
    storage: new MemoryStorage({
      [TRANSPORT_INFO_LINE_MODE_STORAGE_KEY]: 'album'
    })
  })

  assert.equal(
    file.categories.interface?.localStorage[TRANSPORT_INFO_LINE_MODE_STORAGE_KEY],
    'album'
  )
})

test('import replaces selected categories and leaves unselected categories untouched', async () => {
  const storage = new MemoryStorage({
    [THEME_STORAGE_KEY]: 'old-theme',
    [EQ_STORAGE_KEY]: 'keep-eq',
  })
  const file = createSettingsTransferFile(['appearance'], {
    storage: new MemoryStorage({
      [THEME_STORAGE_KEY]: 'new-theme',
      [EQ_STORAGE_KEY]: 'ignored-eq',
    }),
  })

  const result = await applySettingsTransferFile(file, ['appearance'], { storage })

  assert.deepEqual(result, { ok: true, importedCategoryIds: ['appearance'] })
  assert.equal(storage.getItem(THEME_STORAGE_KEY), 'new-theme')
  assert.equal(storage.getItem(EQ_STORAGE_KEY), 'keep-eq')
})

test('missing keys inside a selected category reset those preferences to defaults', async () => {
  const storage = new MemoryStorage({
    [UI_SCALE_STORAGE_KEY]: '125',
    [HOME_GREETING_TEXT_MODE_STORAGE_KEY]: 'clock',
    [TRANSPORT_INFO_LINE_MODE_STORAGE_KEY]: 'hidden',
  })
  const file = createSettingsTransferFile(['interface'], {
    storage: new MemoryStorage({
      [UI_SCALE_STORAGE_KEY]: '110',
    }),
  })

  const result = await applySettingsTransferFile(file, ['interface'], { storage })

  assert.equal(result.ok, true)
  assert.equal(storage.getItem(UI_SCALE_STORAGE_KEY), '110')
  assert.equal(storage.getItem(HOME_GREETING_TEXT_MODE_STORAGE_KEY), null)
  assert.equal(storage.getItem(TRANSPORT_INFO_LINE_MODE_STORAGE_KEY), null)
})

test('invalid schema and kind are rejected, unknown categories are ignored', () => {
  assert.deepEqual(parseSettingsTransferFile('{"kind":"other","schemaVersion":1,"categories":{}}'), {
    ok: false,
    error: 'This file was not exported by Astra settings transfer.',
  })
  assert.deepEqual(parseSettingsTransferFile('{"kind":"astra-settings-transfer","schemaVersion":99,"categories":{}}'), {
    ok: false,
    error: 'This settings transfer file uses an unsupported version.',
  })

  const parsed = parseSettingsTransferFile(JSON.stringify({
    kind: 'astra-settings-transfer',
    schemaVersion: 1,
    exportedAt: '2026-06-25T00:00:00.000Z',
    appVersion: 'test',
    categories: {
      appearance: { localStorage: { [THEME_STORAGE_KEY]: 'theme' } },
      unknown_category: { localStorage: { mystery: 'value' } },
    },
  }))

  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.deepEqual(getImportableSettingsTransferCategoryIds(parsed.file), ['appearance'])
    assert.equal('unknown_category' in parsed.file.categories, false)
  }
})

test('lyrics online preference is a non-secret integration value, not library or cache data', async () => {
  const file = createSettingsTransferFile(['non_secret_integrations'], {
    storage: new MemoryStorage({
      [LYRICS_DISPLAY_SETTINGS_STORAGE_KEY]: '{"wordTimingEnabled":true}',
      [NORMALIZATION_ENABLED_STORAGE_KEY]: '0',
      'astra-lyrics-cache-v1': 'cached lyrics',
    }),
    lyricsOnlineEnabled: true,
    lyricsLrclibBaseUrl: 'http://lyrics.local:8080/mirror',
  })

  assert.deepEqual(file.categories.non_secret_integrations?.values, {
    lyricsOnlineEnabled: true,
    lyricsLrclibBaseUrl: 'http://lyrics.local:8080/mirror'
  })
  assert.equal(
    file.categories.non_secret_integrations?.localStorage[LYRICS_DISPLAY_SETTINGS_STORAGE_KEY],
    '{"wordTimingEnabled":true}'
  )
  assert.equal(file.categories.non_secret_integrations?.localStorage[NORMALIZATION_ENABLED_STORAGE_KEY], undefined)
  assert.equal(file.categories.non_secret_integrations?.localStorage['astra-lyrics-cache-v1'], undefined)

  let importedLyricsEnabled: boolean | null = null
  let importedLrclibBaseUrl: string | null = null
  const result = await applySettingsTransferFile(file, ['non_secret_integrations'], {
    storage: new MemoryStorage(),
    setLyricsOnlineEnabled: (enabled) => {
      importedLyricsEnabled = enabled
    },
    setLyricsLrclibBaseUrl: (baseUrl) => {
      importedLrclibBaseUrl = baseUrl
    },
  })

  assert.equal(result.ok, true)
  assert.equal(importedLyricsEnabled, true)
  assert.equal(importedLrclibBaseUrl, 'http://lyrics.local:8080/mirror')
})

test('listening categories carry an encoded payload and contribute no localStorage keys', () => {
  const file = createSettingsTransferFile(['listening_stats', 'listening_history'], {
    storage: new MemoryStorage({
      [THEME_STORAGE_KEY]: 'should-not-travel-here',
      [LISTENING_STATS_ENABLED_STORAGE_KEY]: '1',
    }),
    listeningCountsEncoded: '{"v":1,"tracks":[],"plays":[],"ratings":[],"favorites":[]}',
    listeningHistoryEncoded: '{"v":1,"tracks":[],"sessions":[],"segments":[]}',
  })

  assert.deepEqual(file.categories.listening_stats?.localStorage, {})
  assert.deepEqual(file.categories.listening_history?.localStorage, {})
  assert.deepEqual(collectExportedStorageKeys(file), [])
  assert.equal(
    file.categories.listening_stats?.values?.encoded,
    '{"v":1,"tracks":[],"plays":[],"ratings":[],"favorites":[]}'
  )
  assert.equal(
    file.categories.listening_history?.values?.encoded,
    '{"v":1,"tracks":[],"sessions":[],"segments":[]}'
  )
})

test('a listening category with no payload still exports a stable shape', () => {
  const file = createSettingsTransferFile(['listening_stats'], { storage: new MemoryStorage() })
  assert.deepEqual(file.categories.listening_stats?.values, { encoded: '' })
})

test('the encoded payload survives serialization while the file stays pretty-printed', () => {
  const encoded = '{"v":1,"tracks":[["/music/a.flac","A","Artist","Album","AA"]],"plays":[[0,7,1700]],"ratings":[],"favorites":[]}'
  const file = createSettingsTransferFile(['appearance', 'listening_stats'], {
    storage: new MemoryStorage({ [THEME_STORAGE_KEY]: 'theme' }),
    listeningCountsEncoded: encoded,
  })

  const serialized = serializeSettingsTransferFile(file)
  assert.ok(serialized.includes('\n  "kind"'), 'the surrounding file should remain indented')

  const parsed = parseSettingsTransferFile(serialized)
  assert.equal(parsed.ok, true)
  assert.ok(parsed.ok)
  assert.equal(parsed.file.categories.listening_stats?.values?.encoded, encoded)
})

test('the listening apply callback runs once with both payloads', async () => {
  const file = createSettingsTransferFile(['listening_stats', 'listening_history'], {
    storage: new MemoryStorage(),
    listeningCountsEncoded: 'counts-payload',
    listeningHistoryEncoded: 'history-payload',
  })

  const calls: Array<{ counts?: string; history?: string }> = []
  const result = await applySettingsTransferFile(file, ['listening_stats', 'listening_history'], {
    storage: new MemoryStorage(),
    applyListeningStatsTransfer: async (request) => {
      calls.push(request)
      return { ...emptyImportResult, countsApplied: true, historyApplied: true }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { counts: 'counts-payload', history: 'history-payload' })
  assert.ok(result.ok)
  assert.equal(result.listeningStats?.countsApplied, true)
})

test('selecting only the counts category leaves the history payload undefined', async () => {
  const file = createSettingsTransferFile(['listening_stats', 'listening_history'], {
    storage: new MemoryStorage(),
    listeningCountsEncoded: 'counts-payload',
    listeningHistoryEncoded: 'history-payload',
  })

  const calls: Array<{ counts?: string; history?: string }> = []
  await applySettingsTransferFile(file, ['listening_stats'], {
    storage: new MemoryStorage(),
    applyListeningStatsTransfer: async (request) => {
      calls.push(request)
      return emptyImportResult
    },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].counts, 'counts-payload')
  assert.equal(calls[0].history, undefined)
})

test('an unselected listening category never reaches the apply callback', async () => {
  const file = createSettingsTransferFile(['appearance', 'listening_history'], {
    storage: new MemoryStorage({ [THEME_STORAGE_KEY]: 'theme' }),
    listeningHistoryEncoded: 'history-payload',
  })

  let called = false
  const result = await applySettingsTransferFile(file, ['appearance'], {
    storage: new MemoryStorage(),
    applyListeningStatsTransfer: async () => {
      called = true
      return emptyImportResult
    },
  })

  assert.equal(called, false)
  assert.ok(result.ok)
  assert.equal(result.listeningStats, undefined)
})

test('a listening category with an empty payload does not invoke the apply callback', async () => {
  const file = createSettingsTransferFile(['listening_stats'], { storage: new MemoryStorage() })

  let called = false
  await applySettingsTransferFile(file, ['listening_stats'], {
    storage: new MemoryStorage(),
    applyListeningStatsTransfer: async () => {
      called = true
      return emptyImportResult
    },
  })

  assert.equal(called, false)
})

test('detailed listening history is the only category left unticked by default', () => {
  assert.equal(DEFAULT_EXPORT_SETTINGS_TRANSFER_CATEGORY_IDS.includes('listening_history'), false)
  assert.equal(DEFAULT_EXPORT_SETTINGS_TRANSFER_CATEGORY_IDS.includes('listening_stats'), true)
  assert.equal(DEFAULT_EXPORT_SETTINGS_TRANSFER_CATEGORY_IDS.includes('appearance'), true)
})

test('older settings transfers without an LRCLIB URL restore the official endpoint', async () => {
  const file: AstraSettingsTransferFile = {
    kind: 'astra-settings-transfer',
    schemaVersion: 1,
    exportedAt: '2026-06-25T00:00:00.000Z',
    appVersion: '0.6.1-beta',
    categories: {
      non_secret_integrations: {
        localStorage: {},
        values: { lyricsOnlineEnabled: true }
      }
    }
  }
  let importedLrclibBaseUrl: string | null = null

  const result = await applySettingsTransferFile(file, ['non_secret_integrations'], {
    storage: new MemoryStorage(),
    setLyricsLrclibBaseUrl: (baseUrl) => {
      importedLrclibBaseUrl = baseUrl
    }
  })

  assert.equal(result.ok, true)
  assert.equal(importedLrclibBaseUrl, LRCLIB_OFFICIAL_BASE_URL)
})
