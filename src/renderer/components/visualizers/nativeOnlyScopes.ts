import type { ScopeKind } from '../../../types/scopePopout'

// Scopes with no JavaScript fallback: they render nothing usable when the native DSP addon
// fails to load, so the docked panel replaces their canvas with a "native DSP unavailable" notice.
//
// The remaining scopes are intentionally excluded because they still respond to audio without
// the native module and keep drawing (at reduced quality):
//   - vectorscope: plots raw L/R samples via Vectorscope.drawFallbackPoints
//   - waveform:    JS min/max column path (Waveform.useNativeAnalyzer() === false branch)
//   - vumeter:     JS VUMeterBallistics.process()
export const NATIVE_ONLY_SCOPES: ReadonlySet<ScopeKind> = new Set<ScopeKind>([
  'spectrum',
  'oscilloscope',
  'spectrogram',
  'lufsmeter',
])

export function isNativeOnlyScope(scope: ScopeKind): boolean {
  return NATIVE_ONLY_SCOPES.has(scope)
}
