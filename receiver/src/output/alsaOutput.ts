import { loadAlsaAddon, type AlsaAddon } from './alsaAddon'
import type { OutputBackend } from './types'

// ALSA output backend for Linux (Raspberry Pi). Thin wrapper over the purpose-built
// receiver/native addon: push-model interleaved Float32 writes plus snd_pcm_delay — the
// DAC-accurate replacement for AudioContext.getOutputTimestamp(). Use 'default' or a plug device
// ('plughw:0,0'); the plug layer converts Float32 → whatever the DAC speaks. Raw 'hw:' devices
// only work when the hardware accepts FLOAT_LE directly.

export class AlsaOutput implements OutputBackend {
  readonly deviceId: string
  readonly deviceLabel: string
  readonly sampleRate: number
  readonly channels: number

  private readonly addon: AlsaAddon
  private written = 0
  private closed = false

  constructor(device: string, sampleRate = 48000, channels = 2) {
    this.addon = loadAlsaAddon()
    const opened = this.addon.open(device, sampleRate, channels)
    this.deviceId = device
    this.deviceLabel = `ALSA ${device}`
    this.sampleRate = opened.sampleRate
    this.channels = channels
  }

  write(interleaved: Float32Array, frames: number): number {
    if (this.closed || frames <= 0) return 0
    const accepted = this.addon.write(interleaved, frames)
    this.written += accepted
    return accepted
  }

  framesWritten(): number {
    return this.written
  }

  bufferedFrames(): number {
    if (this.closed) return 0
    return this.addon.delayFrames()
  }

  underruns(): number {
    if (this.closed) return 0
    return this.addon.underruns()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.addon.close()
  }
}
