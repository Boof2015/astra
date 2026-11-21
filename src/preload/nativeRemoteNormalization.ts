import { AdaptiveNormalization, adaptiveNormalizationRampSeconds, ADAPTIVE_NORMALIZATION_MIN_DELTA_DB } from '../shared/audio/adaptiveNormalization'
import { resolveStaticNormalizationGain } from '../shared/audio/normalizationGain'
import type { NativeAudioSampleFormat, NativeAudioTrackGain, NativeRemoteNormalizationState } from '../types/nativeAudio'
import type { RemoteAudioLoudness } from '../types/remoteAudioAnalysis'
import type { NativeProgressiveInput } from '../types/nativeProgressive'

/** Compact evidence survives decoder replacements, including source rate changes. */
export interface NativeNormalizationEvidence {
  estimator: AdaptiveNormalization
  final: RemoteAudioLoudness | null
}

export class NativeRemoteNormalization {
  readonly evidence: NativeNormalizationEvidence
  private readonly input: NativeProgressiveInput
  private readonly rate: number
  private readonly channels: number
  private readonly format: NativeAudioSampleFormat
  private requested: NativeAudioTrackGain
  private target: number | undefined
  private attached = false
  private attaching = false
  private readonly continuing: boolean
  private pendingFinal: RemoteAudioLoudness | null = null
  private last: NativeAudioTrackGain | null = null

  constructor(input: NativeProgressiveInput, channels: number, format: NativeAudioSampleFormat,
    requested: NativeAudioTrackGain, target: number | undefined, loudness: RemoteAudioLoudness | null | undefined,
    previous?: NativeNormalizationEvidence) {
    this.input = input
    this.rate = input.status().sampleRate
    this.channels = channels
    this.format = format
    this.requested = requested
    this.continuing = !!previous
    this.target = Number.isFinite(target) ? target : undefined
    this.evidence = previous ?? { estimator: new AdaptiveNormalization(this.rate), final: loudness ?? null }
    this.publish(true)
    if (loudness) this.settle(loudness)
  }

  get state(): NativeRemoteNormalizationState {
    if (this.requested.mode !== 'normalization' || this.target === undefined) {
      return { gain: { mode: this.requested.mode, gainDb: this.requested.gainDb }, approximate: false }
    }
    const final = this.evidence.final
    const gain = final ? resolveStaticNormalizationGain({ targetLufs: this.target, ...final,
      peakLinear: final.peakLinear ?? 0, minGainDb: -18, maxGainDb: 6, peakCeilingLinear: 0.98 })
      : this.evidence.estimator.gain(this.target)
    return { gain: { mode: 'normalization', gainDb: gain.gainDb }, approximate: !final }
  }

  setSettings(gain: NativeAudioTrackGain): void {
    this.requested = gain
    if (Number.isFinite(gain.normalizationTargetLufs)) this.target = gain.normalizationTargetLufs
    this.publish(true, true)
  }

  beginAttach(): void { this.attaching = true }

  endAttach(): void {
    this.attaching = false
    this.attached = true
    if (this.pendingFinal) {
      const final = this.pendingFinal
      this.pendingFinal = null
      this.settle(final)
    }
    // A native seek can have been committing while more PCM/analysis arrived.
    this.publish(true)
  }

  settle(analysis: RemoteAudioLoudness): void {
    if (this.evidence.final || !Number.isFinite(analysis.loudnessLufs)) return
    if (this.continuing && !this.attached) {
      this.pendingFinal = analysis
      return
    }
    this.evidence.final = analysis
    this.publish(true)
  }

  observe = (bytes: Uint8Array, startFrame: number): void => {
    if (this.requested.mode !== 'normalization' || this.target === undefined || this.evidence.final
      || this.input.status().state === 'cancelled') return
    const width = this.format === 's16' ? 2 : this.format === 's24' ? 3 : 4
    const frames = bytes.byteLength / (width * this.channels)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const planar = Array.from({ length: this.channels }, () => new Float32Array(frames))
    for (let frame = 0, offset = 0; frame < frames; frame++) {
      for (let channel = 0; channel < this.channels; channel++, offset += width) {
        let value: number
        if (this.format === 'f32') value = view.getFloat32(offset, true)
        else if (width === 2) value = view.getInt16(offset, true) / 32768
        else if (width === 4) value = view.getInt32(offset, true) / 2147483648
        else value = ((view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getInt8(offset + 2) << 16)) / 8388608
        planar[channel][frame] = Number.isFinite(value) ? value : 0
      }
    }
    this.evidence.estimator.ingest(planar, startFrame, this.rate)
    this.publish()
  }

  private publish(force = false, settingsChange = false): void {
    if (this.attaching || this.input.status().state === 'cancelled') return
    const state = this.state
    const previous = this.last
    // An unrelated DSP/settings refresh must not restart or shorten a live ramp.
    if (previous?.mode === state.gain.mode && previous.gainDb === state.gain.gainDb) return
    if (!force && previous?.mode === state.gain.mode
      && Math.abs(previous.gainDb - state.gain.gainDb) < ADAPTIVE_NORMALIZATION_MIN_DELTA_DB && state.approximate) return
    this.last = state.gain
    this.input.setGain(state.gain, this.attached && previous
      ? settingsChange ? 0.020 : adaptiveNormalizationRampSeconds(previous.gainDb, state.gain.gainDb) : 0)
  }
}
