import { strict as assert } from 'node:assert'
import test from 'node:test'

const values = new Map<string, string>()
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
})

const {
  ANALYZER_PROFILE_STORAGE_VERSION,
  ANALYZER_PROFILES_STORAGE_KEY,
  normalizeAnalyzerWorkingState,
  useVisualizerSettingsStore,
} = await import('./visualizerSettingsStore.ts')

test('v4 migration fills adaptive bar defaults and round-trips valid values', () => {
  assert.equal(ANALYZER_PROFILE_STORAGE_VERSION, 4)
  const migrated = normalizeAnalyzerWorkingState({ scopeSettings: { spectrum: { fftSize: 2048 } } })
  assert.equal(migrated.scopeSettings.spectrum.barDensity, 10)
  assert.equal(migrated.scopeSettings.spectrum.barGapPercent, 25)
  assert.equal(migrated.scopeSettings.spectrum.barCornerRadiusPx, 2)
  assert.equal(migrated.scopeSettings.spectrum.showBarPeaks, false)
  assert.equal(migrated.scopeSettings.spectrum.heatPalette, 'classic')

  const customized = normalizeAnalyzerWorkingState({
    ...migrated,
    scopeSettings: {
      ...migrated.scopeSettings,
      spectrum: {
        ...migrated.scopeSettings.spectrum,
        barDensity: 24,
        barGapPercent: 70,
        barCornerRadiusPx: 12,
        showBarPeaks: true,
        heatPalette: 'accent',
      },
    },
  })
  assert.deepEqual(normalizeAnalyzerWorkingState(customized), customized)
})

test('bar setters clamp, mark the profile dirty, and persist a v4 envelope', () => {
  const store = useVisualizerSettingsStore.getState()
  store.resetToDefaults()
  useVisualizerSettingsStore.getState().setSpectrumBarDensity(999)
  useVisualizerSettingsStore.getState().setSpectrumBarGapPercent(-5)
  useVisualizerSettingsStore.getState().setSpectrumBarCornerRadiusPx(9)
  useVisualizerSettingsStore.getState().setSpectrumShowBarPeaks(true)
  useVisualizerSettingsStore.getState().setSpectrumHeatPalette('accent')

  const next = useVisualizerSettingsStore.getState()
  assert.equal(next.spectrumBarDensity, 24)
  assert.equal(next.spectrumBarGapPercent, 0)
  assert.equal(next.spectrumBarCornerRadiusPx, 9)
  assert.equal(next.spectrumShowBarPeaks, true)
  assert.equal(next.spectrumHeatPalette, 'accent')
  assert.equal(next.hasUnsavedProfileChanges, true)

  const persisted = JSON.parse(values.get(ANALYZER_PROFILES_STORAGE_KEY) ?? '{}')
  assert.equal(persisted.version, 4)
  assert.equal(persisted.workingState.scopeSettings.spectrum.heatPalette, 'accent')
})

test.after(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})
