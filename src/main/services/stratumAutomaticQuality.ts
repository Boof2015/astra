import type { AutomaticStreamingQuality, AudioTransferEvent } from './automaticStreamingQuality.ts'
import type { AutomaticStreamingQuality as QualityMode, RemotePlaybackQuality, StreamQualityTarget } from '../../types/streamingQuality.ts'
import type { StratumProofQuality, StratumProofSource } from './stratumProofClient.ts'

export const stratumTarget = (quality: StratumProofQuality): StreamQualityTarget =>
  quality === 'lossless' ? 'original' : quality === 'opus-64' ? 64 : 128
const representation = (target: StreamQualityTarget): StratumProofQuality =>
  target === 'original' ? 'lossless' : target === 64 ? 'opus-64' : 'opus-128'

export function stratumPlaybackQuality(source: StratumProofSource, quality: StratumProofQuality, mode?: QualityMode): RemotePlaybackQuality {
  return { requested: stratumTarget(quality), ...(mode ? { mode } : {}),
    requestedCodec: quality === 'lossless' ? 'flac' : 'opus',
    delivered: { codec: quality === 'lossless' ? 'flac' : 'opus',
      sampleRate: quality === 'lossless' ? source.sample_rate : 48000, channels: source.channels,
      bitDepth: quality === 'lossless' ? source.bits_per_sample : null,
      // Target bitrate is not a measurement of a short VBR response.
      bitrateKbps: null } }
}

/** Shares Astra's policy, while giving it interval costs instead of whole-file
 * replacement costs. Each playback owns decisions; server transfer history is
 * shared, including concurrent next-track fetching. Nothing observes cache/PCM reads. */
export class StratumAutomaticQuality {
  private current: StratumProofQuality
  private first = true
  private committed = false
  private originalKbps: number
  private samples: Array<{ ready: number; media: number; overhead: number }> = []
  private options: {
    mode: QualityMode; policy: AutomaticStreamingQuality; key: string; decisionKey: string
    source: StratumProofSource; initial: StratumProofQuality
    pinInitial?: boolean
    buffer: () => { position: number; ahead: number }
    now?: () => number
  }
  constructor(options: StratumAutomaticQuality['options']) {
    this.options = options
    this.current = options.initial
    this.originalKbps = options.source.sample_rate * options.source.channels * options.source.bits_per_sample / 1000
  }
  private now() { return this.options.now?.() ?? performance.now() }
  choose(frames: number): StratumProofQuality {
    const { policy, mode, key, decisionKey } = this.options
    const ladder = { decisionKey, bitrates: [64, 128] as const }
    if (this.first) {
      this.first = false
      // A seek pins its previous representation. Fresh automatic playback can
      // use recent server evidence before fetching the first interval.
      if (!this.options.pinInitial && this.current === 'lossless') this.current = representation(policy.select(key, mode, this.originalKbps, ladder))
      return this.current
    }
    return this.recommend(frames)
  }
  private recommend(frames: number): StratumProofQuality {
    const { policy, mode, key, decisionKey, source } = this.options
    const ladder = { decisionKey, bitrates: [64, 128] as const }
    const buffer = this.options.buffer()
    const ready = this.samples.reduce((sum, sample) => sum + sample.ready, 0)
    const media = this.samples.reduce((sum, sample) => sum + sample.media, 0)
    const target = policy.recommend(key, mode, {
      originalKbps: this.originalKbps, current: stratumTarget(this.current),
      position: buffer.position, duration: source.frames / source.sample_rate,
      bufferedSeconds: buffer.position + buffer.ahead, loadedBytes: 0, totalBytes: null, complete: false,
      segments: { ...ladder, aheadSeconds: buffer.ahead, nextSeconds: frames / source.sample_rate,
        overheadSeconds: Math.max(0, ...this.samples.map(sample => sample.overhead)),
        deliverySeconds: ready, mediaSeconds: media, observedSeconds: ready }
    })
    return target === null ? this.current : representation(target)
  }
  begin(frames: number) {
    const started = this.now()
    let lastObservation = started
    const observe = this.options.policy.observer(this.options.key, 20)
    let transferStart = 0, transferMs = 0
    return {
      observe: (event: AudioTransferEvent) => {
        if (event.phase === 'start') transferStart = this.now()
        if (event.phase === 'end') transferMs = this.now() - transferStart
        observe(event)
        // A slow segment can take longer than the policy's persistence window.
        // Observe the shrinking buffer during delivery so that the next choice
        // need not wait for another entire slow segment to prove the shortfall.
        // Only choose() selects a representation, at the next interval boundary.
        if (this.committed && event.phase === 'data' && this.now() - lastObservation >= 1000) {
          lastObservation = this.now()
          this.recommend(frames)
        }
      },
      ready: (quality: StratumProofQuality, frames: number, bytes: number) => {
        const seconds = Math.max(.001, (this.now() - started) / 1000)
        const media = frames / this.options.source.sample_rate
        // Do not include waiting for renderer capacity in delivery timings.
        const changed = quality !== this.current
        if (changed) this.samples = []
        this.samples.push({ ready: seconds, media, overhead: Math.max(0, seconds - transferMs / 1000) })
        this.samples = this.samples.slice(-5)
        if (quality === 'lossless') this.originalKbps = Math.max(bytes * 8 / media / 1000, this.originalKbps * .85)
        this.current = quality
        const { policy, key, mode, decisionKey } = this.options
        if (!this.committed || changed) policy.committed(key, mode, stratumTarget(quality), decisionKey)
        this.committed = true
      }
    }
  }
  close() { this.options.policy.releaseDecision(this.options.decisionKey, this.options.mode) }
}
