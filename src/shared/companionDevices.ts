/** Presentation metadata reported by a companion; never grants permissions. */
export interface CompanionDeviceInfo {
  modelId: string
  softwareVersion: string | null
}

export function parseCompanionDeviceInfo(value: unknown): CompanionDeviceInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (typeof item.modelId !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(item.modelId)) return null
  const version = item.softwareVersion
  if (version != null && (typeof version !== 'string' || !version.trim() || version.length > 80 || /[\u0000-\u001f\u007f]/.test(version))) return null
  return { modelId: item.modelId, softwareVersion: typeof version === 'string' ? version.trim() : null }
}

export function companionModelName(info?: CompanionDeviceInfo | null): string {
  return info?.modelId === 'astra-thing' ? 'Astra Thing' : 'Companion device'
}
