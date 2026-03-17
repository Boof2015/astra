import type { ScopeKind } from '../../../types/scopePopout'

const DEFAULT_COLLAPSED_SCOPE_WEIGHT = 1

function usesCollapsedDefaultWeight(scope: ScopeKind): boolean {
  return scope === 'spectrogram'
    || scope === 'vumeter'
    || scope === 'lufsmeter'
    || scope === 'waveform'
}

export function buildAnalyzerGridTemplateColumns(
  visibleScopes: ScopeKind[],
  widthWeights: Partial<Record<ScopeKind, number>>
): string {
  if (visibleScopes.length === 0) return ''

  return visibleScopes.map((scope) => {
    const weight = widthWeights[scope] ?? 1
    if (scope === 'vectorscope') {
      if (weight <= 0) {
        return 'minmax(96px, clamp(96px, 18vw, calc(var(--analyzer-height) - 8px)))'
      }
      return `minmax(clamp(96px, 18vw, calc(var(--analyzer-height) - 8px)), ${weight}fr)`
    }

    if (usesCollapsedDefaultWeight(scope) && weight <= 0) {
      return `minmax(0, ${DEFAULT_COLLAPSED_SCOPE_WEIGHT}fr)`
    }

    return `minmax(0, ${weight}fr)`
  }).join(' ')
}
