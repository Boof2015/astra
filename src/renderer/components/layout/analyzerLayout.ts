import type { ScopeKind } from '../../../types/scopePopout'
import type { VectorscopeMode } from '../../stores/visualizerSettingsStore'

const DEFAULT_COLLAPSED_SCOPE_WEIGHT = 1
const VECTORSCOPE_DRAWABLE_MIN_WIDTH = '96px'
const VECTORSCOPE_LISSAJOUS_TILE_MIN_WIDTH = '152px'
const VECTORSCOPE_SQUARE_BIASED_DEFAULT_WIDTH = 'clamp(96px, 18vw, calc(var(--analyzer-height) - 8px))'
const VECTORSCOPE_LISSAJOUS_DEFAULT_WIDTH = 'clamp(152px, 18vw, calc(var(--analyzer-height) - 8px))'

function usesCollapsedDefaultWeight(scope: ScopeKind): boolean {
  return scope === 'spectrogram'
    || scope === 'vumeter'
    || scope === 'lufsmeter'
    || scope === 'waveform'
}

function vectorscopeMinWidth(vectorscopeMode: VectorscopeMode): string {
  return vectorscopeMode === 'lissajous'
    ? VECTORSCOPE_LISSAJOUS_TILE_MIN_WIDTH
    : VECTORSCOPE_DRAWABLE_MIN_WIDTH
}

function vectorscopeCollapsedWidth(vectorscopeMode: VectorscopeMode): string {
  return vectorscopeMode === 'lissajous'
    ? VECTORSCOPE_LISSAJOUS_DEFAULT_WIDTH
    : VECTORSCOPE_SQUARE_BIASED_DEFAULT_WIDTH
}

export function buildAnalyzerGridTemplateColumns(
  visibleScopes: ScopeKind[],
  widthWeights: Partial<Record<ScopeKind, number>>,
  vectorscopeMode: VectorscopeMode
): string {
  if (visibleScopes.length === 0) return ''
  const hasSingleVisibleScope = visibleScopes.length === 1

  return visibleScopes.map((scope) => {
    const weight = widthWeights[scope] ?? 1
    if (scope === 'vectorscope') {
      const minWidth = vectorscopeMinWidth(vectorscopeMode)
      if (weight <= 0) {
        return `minmax(${minWidth}, ${vectorscopeCollapsedWidth(vectorscopeMode)})`
      }
      if (hasSingleVisibleScope) {
        return `minmax(${minWidth}, 1fr)`
      }
      return `minmax(${minWidth}, ${weight}fr)`
    }

    if (hasSingleVisibleScope) {
      return 'minmax(0, 1fr)'
    }

    if (usesCollapsedDefaultWeight(scope) && weight <= 0) {
      return `minmax(0, ${DEFAULT_COLLAPSED_SCOPE_WEIGHT}fr)`
    }

    return `minmax(0, ${weight}fr)`
  }).join(' ')
}
