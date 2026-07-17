import type { ReceiverConfig } from '../config'
import { AlsaOutput } from './alsaOutput'
import { NullOutput } from './nullOutput'
import type { OutputBackend } from './types'

export function createOutputBackend(config: ReceiverConfig): OutputBackend {
  if (config.audioBackend === 'alsa') {
    return new AlsaOutput(config.audioDevice)
  }
  return new NullOutput()
}
