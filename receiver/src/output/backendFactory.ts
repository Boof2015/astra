import type { ReceiverConfig } from '../config'
import { AlsaOutput } from './alsaOutput'
import { NullOutput } from './nullOutput'
import type { OutputBackend } from './types'

// On desktop-flavored distros, ALSA's 'default' device routes into the user session's
// PulseAudio/PipeWire server, which a headless system service can't reach — snd_pcm_open then
// fails with "Host is down". Direct hardware access via plughw (the service user is in the
// `audio` group) is the correct path for an appliance, so when the configured device won't
// open, fall through the first few cards instead of crash-looping under systemd.
const ALSA_FALLBACK_DEVICES = ['default', 'plughw:0,0', 'plughw:1,0', 'plughw:2,0']

export function createOutputBackend(config: ReceiverConfig): OutputBackend {
  if (config.audioBackend !== 'alsa') {
    return new NullOutput()
  }

  const candidates = [config.audioDevice, ...ALSA_FALLBACK_DEVICES]
    .filter((device, index, list) => list.indexOf(device) === index)
  const failures: string[] = []
  for (const device of candidates) {
    try {
      const backend = new AlsaOutput(device)
      if (device !== config.audioDevice) {
        console.warn(
          `[astra-receiver] configured ALSA device '${config.audioDevice}' could not be opened — using '${device}' instead. `
          + `Set "audioDevice" in the config to make this explicit.`
        )
      }
      return backend
    } catch (error) {
      failures.push(`  ${device}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(
    'No ALSA output device could be opened. Tried:\n'
    + failures.join('\n')
    + '\nList devices with `aplay -l` (sudo apt install alsa-utils) and set "audioDevice" '
    + '(e.g. "plughw:1,0") in the receiver config.'
  )
}
