import type { MemoryDiagnosticsEventPayload } from '../../types/diagnostics'

function isPrimaryWindow(): boolean {
  const windowMode = new URLSearchParams(window.location.search).get('window')
  return windowMode === null
}

export function logMemoryDiagnosticsEvent(
  name: string,
  details?: Record<string, unknown>,
  source: MemoryDiagnosticsEventPayload['source'] = 'renderer'
): void {
  if (!isPrimaryWindow()) return
  void window.electronAPI.diagnostics.logEvent({
    name,
    source,
    details: details ?? null
  }).catch(() => {
    // Ignore diagnostics logging failures so playback/UI paths stay unaffected.
  })
}

export function isPrimaryRendererWindow(): boolean {
  return isPrimaryWindow()
}
