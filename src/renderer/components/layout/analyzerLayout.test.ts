import test from 'node:test'
import assert from 'node:assert/strict'
import type { ScopeKind } from '../../../types/scopePopout.ts'
import { buildAnalyzerGridTemplateColumns } from './analyzerLayout.ts'

test('single flexible scopes fill the available analyzer rack width', () => {
  const singleFlexibleScopes: ScopeKind[] = [
    'spectrum',
    'oscilloscope',
    'spectrogram',
    'vumeter',
    'lufsmeter',
    'waveform',
  ]

  for (const scope of singleFlexibleScopes) {
    assert.equal(
      buildAnalyzerGridTemplateColumns([scope], {}, 'lissajous'),
      'minmax(0, 1fr)'
    )
    assert.equal(
      buildAnalyzerGridTemplateColumns([scope], { [scope]: 0.4 }, 'lissajous'),
      'minmax(0, 1fr)'
    )
  }
})

test('single collapsed-default scopes still fill the rack when saved at zero weight', () => {
  const collapsedDefaultScopes: ScopeKind[] = [
    'spectrogram',
    'vumeter',
    'lufsmeter',
    'waveform',
  ]

  for (const scope of collapsedDefaultScopes) {
    assert.equal(
      buildAnalyzerGridTemplateColumns([scope], { [scope]: 0 }, 'lissajous'),
      'minmax(0, 1fr)'
    )
  }
})

test('single vectorscope keeps its mode-specific minimum width', () => {
  assert.equal(
    buildAnalyzerGridTemplateColumns(['vectorscope'], {}, 'lissajous'),
    'minmax(152px, 1fr)'
  )
  assert.equal(
    buildAnalyzerGridTemplateColumns(['vectorscope'], { vectorscope: 0.4 }, 'lissajous'),
    'minmax(152px, 1fr)'
  )
  assert.equal(
    buildAnalyzerGridTemplateColumns(['vectorscope'], { vectorscope: 0 }, 'lissajous'),
    'minmax(152px, clamp(152px, 18vw, calc(var(--analyzer-height) - 8px)))'
  )
  assert.equal(
    buildAnalyzerGridTemplateColumns(['vectorscope'], {}, 'polar-bipolar'),
    'minmax(96px, 1fr)'
  )
  assert.equal(
    buildAnalyzerGridTemplateColumns(['vectorscope'], { vectorscope: 0.4 }, 'polar-bipolar'),
    'minmax(96px, 1fr)'
  )
  assert.equal(
    buildAnalyzerGridTemplateColumns(['vectorscope'], { vectorscope: 0 }, 'polar-bipolar'),
    'minmax(96px, clamp(96px, 18vw, calc(var(--analyzer-height) - 8px)))'
  )
})
