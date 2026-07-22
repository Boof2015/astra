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

export interface OutputBackendCreationResult {
  backend: OutputBackend
  /** True only when a real ALSA backend opened successfully. */
  audioAvailable: boolean
  /** Non-null only when ALSA was requested but every candidate failed. */
  audioError: string | null
}

export interface OutputBackendFactoryOptions {
  /** Injectable for tests so they do not need the Linux native addon. */
  createAlsaOutput?: (device: string) => OutputBackend
  log?: (message: string) => void
}

const PUBLIC_ALSA_ERROR = 'No ALSA output device could be opened. '
  + 'Choose a detected output in receiver settings and apply it to retry.'

function safeLogText(value: unknown, maxLength = 240): string {
  const raw = value instanceof Error ? value.message : String(value)
  return raw.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, maxLength) || 'unknown error'
}

function quotedDevice(device: string): string {
  // JSON quoting prevents a hand-edited device name from injecting extra log lines.
  return JSON.stringify(safeLogText(device, 128))
}

export function createOutputBackend(
  config: ReceiverConfig,
  options: OutputBackendFactoryOptions = {}
): OutputBackendCreationResult {
  if (config.audioBackend !== 'alsa') {
    return { backend: new NullOutput(), audioAvailable: false, audioError: null }
  }

  const createAlsaOutput = options.createAlsaOutput ?? ((device: string) => new AlsaOutput(device))
  const log = options.log ?? ((message: string) => console.log(`[astra-receiver] ${message}`))
  const candidates = [config.audioDevice, ...ALSA_FALLBACK_DEVICES]
    .filter((device, index, list) => list.indexOf(device) === index)
  for (const device of candidates) {
    log(`trying ALSA output ${quotedDevice(device)}`)
    try {
      const backend = createAlsaOutput(device)
      if (device !== config.audioDevice) {
        log(
          `configured ALSA output ${quotedDevice(config.audioDevice)} could not be opened — `
          + `using fallback ${quotedDevice(device)}`
        )
      } else {
        log(`opened configured ALSA output ${quotedDevice(device)}`)
      }
      return { backend, audioAvailable: true, audioError: null }
    } catch (error) {
      log(`ALSA output ${quotedDevice(device)} failed: ${safeLogText(error)}`)
    }
  }
  log('no ALSA output candidate opened — continuing with Null output (no audio)')
  return {
    backend: new NullOutput(),
    audioAvailable: false,
    audioError: PUBLIC_ALSA_ERROR
  }
}
