import type { TransportInfoLineMode } from '../stores/uiStore'

export interface TransportInfoLineDescriptor {
  prefix: 'OUT' | 'ALB'
  value: string
  title: string
  action: 'open-album' | null
}

export function resolveTransportInfoLine(
  mode: TransportInfoLineMode,
  outputDeviceLabel: string,
  album: string | null | undefined
): TransportInfoLineDescriptor | null {
  if (mode === 'hidden') return null

  if (mode === 'album') {
    const normalizedAlbum = album?.trim() ?? ''
    return {
      prefix: 'ALB',
      value: normalizedAlbum || '\u2014',
      title: normalizedAlbum ? `Show album ${normalizedAlbum}` : 'Album unavailable',
      action: normalizedAlbum ? 'open-album' : null
    }
  }

  return {
    prefix: 'OUT',
    value: outputDeviceLabel,
    title: outputDeviceLabel,
    action: null
  }
}
