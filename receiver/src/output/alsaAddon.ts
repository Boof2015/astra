import { createRequire } from 'module'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

// Loader for the receiver/native N-API addon, shared by AlsaOutput and the systemd notifier.
// The addon carries more than ALSA playback: sdNotify() sends AF_UNIX datagrams to systemd's
// NOTIFY_SOCKET, which Node core (UDP-only dgram) cannot do.

export interface AlsaAddon {
  open(device: string, sampleRate: number, channels: number): { sampleRate: number }
  write(interleaved: Float32Array, frames: number): number
  delayFrames(): number
  underruns(): number
  close(): void
  // Absent when running against an addon built before receiver v0.2.0.
  sdNotify?(state: string): boolean
}

export function loadAlsaAddon(): AlsaAddon {
  const require = createRequire(import.meta.url)
  const override = process.env.ASTRA_RECEIVER_ALSA_ADDON?.trim()
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    override,
    // From the bundled receiver/dist/astra-receiver.mjs
    join(here, '../native/build/Release/astra_receiver_alsa.node'),
    // From receiver/src/output/ when running unbundled in dev
    join(here, '../../native/build/Release/astra_receiver_alsa.node')
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return require(candidate) as AlsaAddon
    }
  }
  throw new Error(
    'ALSA addon not built. Run `npm run receiver:native` (needs libasound2-dev on Linux), '
    + 'or set audioBackend to "null" in the receiver config.'
  )
}
