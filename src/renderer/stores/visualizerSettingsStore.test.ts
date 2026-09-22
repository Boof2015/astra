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

test('v5 migration fills adaptive bar defaults and round-trips valid values', () => {
  assert.equal(ANALYZER_PROFILE_STORAGE_VERSION, 5)
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

test('bar setters clamp, mark the profile dirty, and persist a v5 envelope', () => {
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
  assert.equal(persisted.version, 5)
  assert.equal(persisted.workingState.scopeSettings.spectrum.heatPalette, 'accent')
})

test.after(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})


test('v4 profiles acquire safe frequency defaults and new controls survive saving', () => {
  const old = normalizeAnalyzerWorkingState({ scopeSettings: {
    spectrum: { fftSize: 8192, smoothing: 0.72 },
    spectrogram: { scaleMode: 'mel' },
    vectorscope: { mode: 'polar-bipolar' },
  } })
  assert.equal(old.scopeSettings.spectrum.scaleMode, 'log')
  assert.equal(old.scopeSettings.spectrum.rangeMode, 'audible')
  assert.equal(old.scopeSettings.spectrum.fftSize, 8192)
  assert.equal(old.scopeSettings.spectrogram.scaleMode, 'mel')
  assert.equal(old.scopeSettings.spectrogram.rangeMode, 'audible')
  assert.equal(old.scopeSettings.vectorscope.zoomDb, 0)

  const store = useVisualizerSettingsStore.getState()
  store.resetToDefaults()
  store.setSpectrumScaleMode('mel')
  store.setSpectrumRangeMode('extended')
  store.setSpectrogramRangeMode('extended')
  store.setVectorscopeZoomDb(6)
  const next = useVisualizerSettingsStore.getState()
  assert.equal(next.spectrumScaleMode, 'mel')
  assert.equal(next.vectorscopeZoomDb, 6)
  assert.equal(next.hasUnsavedProfileChanges, true)
  const persisted = JSON.parse(values.get(ANALYZER_PROFILES_STORAGE_KEY) ?? '{}')
  const restored = normalizeAnalyzerWorkingState(persisted.workingState)
  assert.equal(restored.scopeSettings.spectrum.scaleMode, 'mel')
  assert.equal(restored.scopeSettings.spectrum.rangeMode, 'extended')
  assert.equal(restored.scopeSettings.spectrogram.rangeMode, 'extended')
  assert.equal(restored.scopeSettings.vectorscope.zoomDb, 6)
  store.revertToSelectedProfile()
  assert.equal(useVisualizerSettingsStore.getState().spectrumScaleMode, 'log')
  assert.equal(useVisualizerSettingsStore.getState().vectorscopeZoomDb, 0)
})

test('Reassigned spectrogram is opt-in and survives profile save, normalization and revert', () => {
  const store = useVisualizerSettingsStore.getState()
  store.resetToDefaults()
  assert.equal(useVisualizerSettingsStore.getState().spectrogramClarityMode, 'sharper')
  assert.equal(normalizeAnalyzerWorkingState({}).scopeSettings.spectrogram.clarityMode, 'sharper')

  store.setSpectrogramClarityMode('reassigned')
  assert.equal(useVisualizerSettingsStore.getState().hasUnsavedProfileChanges, true)
  const saved = store.saveCurrentProfileAs('Reassigned spectrogram')
  assert.equal(saved.ok, true)
  assert.equal(useVisualizerSettingsStore.getState().hasUnsavedProfileChanges, false)
  const persisted = JSON.parse(values.get(ANALYZER_PROFILES_STORAGE_KEY) ?? '{}')
  assert.equal(normalizeAnalyzerWorkingState(persisted.workingState).scopeSettings.spectrogram.clarityMode, 'reassigned')

  store.setSpectrogramClarityMode('classic')
  store.revertToSelectedProfile()
  assert.equal(useVisualizerSettingsStore.getState().spectrogramClarityMode, 'reassigned')
})
