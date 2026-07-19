import { readFileSync } from 'fs'

// Sound-card enumeration for the web page's output picker. Same source and parse as the
// installer's device prompt (/proc/asound/cards; no alsa-utils dependency), producing the same
// plughw:<NAME>,0 ids the installer writes — the plug layer handles format conversion.

export interface AlsaDeviceOption {
  id: string
  label: string
}

// Lines look like: ` 0 [vc4hdmi0       ]: vc4-hdmi - vc4-hdmi-0`
const CARD_LINE = /^\s*\d+\s+\[([^\]]+)\]:\s*(.*)$/

export function parseAlsaCards(text: string): AlsaDeviceOption[] {
  const devices: AlsaDeviceOption[] = []
  for (const line of text.split('\n')) {
    const match = CARD_LINE.exec(line)
    if (!match) continue
    const name = match[1].trimEnd()
    if (!name) continue
    devices.push({ id: `plughw:${name},0`, label: `${name} — ${match[2].trim()}` })
  }
  return devices
}

export function listAlsaDevices(
  path = process.env.ASTRA_RECEIVER_CARDS_FILE?.trim() || '/proc/asound/cards'
): AlsaDeviceOption[] {
  try {
    return parseAlsaCards(readFileSync(path, 'utf8'))
  } catch {
    // No procfs (mac dev) or unreadable — the picker simply offers nothing to switch to.
    return []
  }
}
