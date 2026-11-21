import { ProgressiveKWeightedLoudnessAnalyzer, resolveStaticNormalizationGain } from './loudness'

// A provisional estimate, not a replacement for the complete-cache EBU scan.
// Keep only 400 ms summaries, never PCM. Repeated/overlapping playback and
// quality replacements cannot add the same timeline window twice.
const MAX_WINDOWS = 90_000 // Ten hours of distinct audio at 400 ms/window.
const FLOOR_LUFS = -70
const BIN_WIDTH_LU = 0.25
const BIN_COUNT = 400

export class AdaptiveNormalization {
  readonly sampleRate: number
  private readonly windowFrames: number
  private analyzer: ProgressiveKWeightedLoudnessAnalyzer
  private readonly seen = new Set<number>()
  private readonly energies = new Float64Array(BIN_COUNT)
  private readonly counts = new Uint32Array(BIN_COUNT)
  private cursor = -1
  private peakLinear = 0
  private loudestEstimate = Number.NEGATIVE_INFINITY

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
    this.windowFrames = Math.max(1, Math.round(sampleRate * 0.4))
    this.analyzer = new ProgressiveKWeightedLoudnessAnalyzer(sampleRate)
  }

  get measuredSeconds(): number { return this.seen.size * this.windowFrames / this.sampleRate }

  ingest(channels: readonly Float32Array[], startFrame: number): void {
    const frames = channels.length ? Math.min(...channels.map(channel => channel.length)) : 0
    if (!frames || this.seen.size >= MAX_WINDOWS) return
    if (startFrame !== this.cursor) {
      // A seek is a filter discontinuity, not new evidence about old audio.
      this.analyzer = new ProgressiveKWeightedLoudnessAnalyzer(this.sampleRate)
      this.cursor = Math.ceil(startFrame / this.windowFrames) * this.windowFrames
    }
    let offset = Math.max(0, this.cursor - startFrame)
    while (offset < frames && this.seen.size < MAX_WINDOWS) {
      const window = Math.floor(this.cursor / this.windowFrames)
      const length = Math.min(frames - offset, (window + 1) * this.windowFrames - this.cursor)
      if (!this.seen.has(window)) {
        this.analyzer.ingest(channels.map(channel => channel.subarray(offset, offset + length)))
      }
      offset += length
      this.cursor += length
      if (this.cursor % this.windowFrames !== 0) continue
      if (!this.seen.has(window)) {
        const analysis = this.analyzer.getAnalysis()
        this.seen.add(window)
        if (analysis && Number.isFinite(analysis.loudnessLufs) && Number.isFinite(analysis.peakLinear)) {
          this.peakLinear = Math.max(this.peakLinear, analysis.peakLinear)
          if (analysis.loudnessLufs >= FLOOR_LUFS) {
            const bin = Math.min(BIN_COUNT - 1, Math.floor((analysis.loudnessLufs - FLOOR_LUFS) / BIN_WIDTH_LU))
            this.energies[bin] += 10 ** ((analysis.loudnessLufs + 0.691) / 10)
            this.counts[bin]++
            this.updateEstimate()
          }
        }
        this.analyzer.resetMeasurement()
      } else {
        // Skipped cached coverage supplies no filter history for the next run.
        this.analyzer = new ProgressiveKWeightedLoudnessAnalyzer(this.sampleRate)
      }
    }
  }

  private updateEstimate(): void {
    // Update on timeline windows, independent of decoder/IPC chunk sizes.
    let energy = 0, count = 0
    for (let i = 0; i < BIN_COUNT; i++) { energy += this.energies[i]; count += this.counts[i] }
    const relativeGate = -0.691 + 10 * Math.log10(energy / count) - 10
    energy = 0; count = 0
    for (let i = 0; i < BIN_COUNT; i++) {
      if (FLOOR_LUFS + i * BIN_WIDTH_LU < relativeGate) continue
      energy += this.energies[i]; count += this.counts[i]
    }
    if (count) this.loudestEstimate = Math.max(this.loudestEstimate, -0.691 + 10 * Math.log10(energy / count))
  }

  gain(targetLufs: number): { gainDb: number; linearGain: number; mode: 'normalization' } {
    // Until the complete result exists, never turn a quiet intro up or release
    // attenuation as the music gets quieter. At the default -14 LUFS target,
    // the initial allowance is -6 dB; louder evidence can reduce it further.
    const gain = resolveStaticNormalizationGain({ targetLufs,
      loudnessLufs: Math.max(-8, this.loudestEstimate), peakLinear: this.peakLinear,
      minGainDb: -18, maxGainDb: 0, peakCeilingLinear: 0.98 })
    return { gainDb: gain.gainDb, linearGain: gain.linearGain, mode: 'normalization' }
  }
}
