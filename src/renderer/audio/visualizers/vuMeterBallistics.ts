export interface VUMeterStereoChunk {
  left: Float32Array
  right: Float32Array
}

export interface VUMeterSnapshot {
  vuLDb: number
  vuRDb: number
  barLDb: number
  barRDb: number
  peakLDb: number
  peakRDb: number
  correlation: number
}

export const VU_METER_MIN_DB = -60
export const VU_METER_MAX_DB = 0
export const VU_INTEGRATION_WINDOW_MS = 300
export const VU_PEAK_HOLD_MS = 750
export const VU_PEAK_DECAY_DB_PER_SECOND = 18
const BAR_ATTACK_MS = 5
const BAR_RELEASE_MS = 180

const INITIAL_SNAPSHOT: VUMeterSnapshot = {
  vuLDb: VU_METER_MIN_DB,
  vuRDb: VU_METER_MIN_DB,
  barLDb: VU_METER_MIN_DB,
  barRDb: VU_METER_MIN_DB,
  peakLDb: VU_METER_MIN_DB,
  peakRDb: VU_METER_MIN_DB,
  correlation: 0,
}

function clampSampleRate(sampleRate: number): number {
  return Math.max(1, Math.floor(sampleRate) || 1)
}

function amplitudeToDb(amplitude: number): number {
  if (!Number.isFinite(amplitude) || amplitude <= 0) {
    return VU_METER_MIN_DB
  }
  const db = 20 * Math.log10(Math.max(amplitude, 1e-10))
  return Math.max(VU_METER_MIN_DB, Math.min(VU_METER_MAX_DB, db))
}

export class VUMeterBallistics {
  private sampleRate = 48000
  private integrationWindowSamples = 1
  private sqL = new Float64Array(1)
  private sqR = new Float64Array(1)
  private cross = new Float64Array(1)
  private writeIndex = 0
  private sampleCount = 0
  private sumSqL = 0
  private sumSqR = 0
  private sumCross = 0
  private peakHoldUntilL = 0
  private peakHoldUntilR = 0
  private lastPeakUpdateMs: number | null = null
  private barEnvelopeL = 0
  private barEnvelopeR = 0
  private barAttackCoeff = 0
  private barReleaseCoeff = 0
  private snapshot: VUMeterSnapshot = { ...INITIAL_SNAPSHOT }

  constructor(sampleRate: number) {
    this.reinitialize(sampleRate)
  }

  getSampleRate(): number {
    return this.sampleRate
  }

  reinitialize(sampleRate: number): void {
    this.sampleRate = clampSampleRate(sampleRate)
    this.integrationWindowSamples = Math.max(
      1,
      Math.round((this.sampleRate * VU_INTEGRATION_WINDOW_MS) / 1000),
    )
    this.sqL = new Float64Array(this.integrationWindowSamples)
    this.sqR = new Float64Array(this.integrationWindowSamples)
    this.cross = new Float64Array(this.integrationWindowSamples)
    this.barAttackCoeff = Math.exp(-1 / (this.sampleRate * (BAR_ATTACK_MS / 1000)))
    this.barReleaseCoeff = Math.exp(-1 / (this.sampleRate * (BAR_RELEASE_MS / 1000)))
    this.reset()
  }

  reset(): void {
    this.sqL.fill(0)
    this.sqR.fill(0)
    this.cross.fill(0)
    this.writeIndex = 0
    this.sampleCount = 0
    this.sumSqL = 0
    this.sumSqR = 0
    this.sumCross = 0
    this.peakHoldUntilL = 0
    this.peakHoldUntilR = 0
    this.lastPeakUpdateMs = null
    this.barEnvelopeL = 0
    this.barEnvelopeR = 0
    this.snapshot = { ...INITIAL_SNAPSHOT }
  }

  process(chunks: readonly VUMeterStereoChunk[], nowMs: number): VUMeterSnapshot {
    this.advancePeaks(nowMs)

    if (chunks.length === 0) {
      return this.getSnapshot()
    }

    let maxPeakL = 0
    let maxPeakR = 0

    for (const chunk of chunks) {
      const len = Math.min(chunk.left.length, chunk.right.length)
      for (let index = 0; index < len; index += 1) {
        const left = chunk.left[index]
        const right = chunk.right[index]
        const sqL = left * left
        const sqR = right * right
        const cross = left * right

        if (this.sampleCount === this.integrationWindowSamples) {
          // Clamp running sums to non-negative: floating-point cancellation in
          // the slide-out subtraction can drift them by ~1e-15 below zero on
          // near-silent content, which would propagate as NaN through sqrt.
          this.sumSqL = Math.max(0, this.sumSqL - this.sqL[this.writeIndex])
          this.sumSqR = Math.max(0, this.sumSqR - this.sqR[this.writeIndex])
          this.sumCross -= this.cross[this.writeIndex]
        } else {
          this.sampleCount += 1
        }

        this.sqL[this.writeIndex] = sqL
        this.sqR[this.writeIndex] = sqR
        this.cross[this.writeIndex] = cross
        this.sumSqL += sqL
        this.sumSqR += sqR
        this.sumCross += cross
        this.writeIndex = (this.writeIndex + 1) % this.integrationWindowSamples

        const absL = Math.abs(left)
        const absR = Math.abs(right)
        this.barEnvelopeL = this.updateBarEnvelope(this.barEnvelopeL, absL)
        this.barEnvelopeR = this.updateBarEnvelope(this.barEnvelopeR, absR)
        if (absL > maxPeakL) maxPeakL = absL
        if (absR > maxPeakR) maxPeakR = absR
      }
    }

    this.maybeUpdatePeak(amplitudeToDb(maxPeakL), nowMs, 'left')
    this.maybeUpdatePeak(amplitudeToDb(maxPeakR), nowMs, 'right')
    this.recomputeSnapshot()
    return this.getSnapshot()
  }

  getSnapshot(): VUMeterSnapshot {
    return { ...this.snapshot }
  }

  private recomputeSnapshot(): void {
    if (this.sampleCount <= 0) {
      this.snapshot.vuLDb = VU_METER_MIN_DB
      this.snapshot.vuRDb = VU_METER_MIN_DB
      this.snapshot.barLDb = amplitudeToDb(this.barEnvelopeL)
      this.snapshot.barRDb = amplitudeToDb(this.barEnvelopeR)
      this.snapshot.correlation = 0
      return
    }

    const meanSqL = Math.max(0, this.sumSqL) / this.sampleCount
    const meanSqR = Math.max(0, this.sumSqR) / this.sampleCount
    const denominator = Math.sqrt(Math.max(0, this.sumSqL) * Math.max(0, this.sumSqR))

    this.snapshot.vuLDb = amplitudeToDb(Math.sqrt(meanSqL))
    this.snapshot.vuRDb = amplitudeToDb(Math.sqrt(meanSqR))
    this.snapshot.barLDb = amplitudeToDb(this.barEnvelopeL)
    this.snapshot.barRDb = amplitudeToDb(this.barEnvelopeR)
    this.snapshot.correlation = denominator > 1e-10
      ? Math.max(-1, Math.min(1, this.sumCross / denominator))
      : 0
  }

  private updateBarEnvelope(current: number, input: number): number {
    const coeff = input > current ? this.barAttackCoeff : this.barReleaseCoeff
    return coeff * current + (1 - coeff) * input
  }

  private advancePeaks(nowMs: number): void {
    if (!Number.isFinite(nowMs)) {
      return
    }

    if (this.lastPeakUpdateMs === null) {
      this.lastPeakUpdateMs = nowMs
      return
    }

    if (nowMs <= this.lastPeakUpdateMs) {
      return
    }

    this.snapshot.peakLDb = this.applyPeakDecay(this.snapshot.peakLDb, this.peakHoldUntilL, nowMs)
    this.snapshot.peakRDb = this.applyPeakDecay(this.snapshot.peakRDb, this.peakHoldUntilR, nowMs)
    this.lastPeakUpdateMs = nowMs
  }

  private applyPeakDecay(currentDb: number, holdUntilMs: number, nowMs: number): number {
    if (this.lastPeakUpdateMs === null) {
      return currentDb
    }

    const decayStartMs = Math.max(this.lastPeakUpdateMs, holdUntilMs)
    if (nowMs <= decayStartMs) {
      return currentDb
    }

    const decayAmount = ((nowMs - decayStartMs) / 1000) * VU_PEAK_DECAY_DB_PER_SECOND
    return Math.max(VU_METER_MIN_DB, currentDb - decayAmount)
  }

  private maybeUpdatePeak(peakDb: number, nowMs: number, channel: 'left' | 'right'): void {
    if (channel === 'left') {
      if (peakDb > this.snapshot.peakLDb) {
        this.snapshot.peakLDb = peakDb
        this.peakHoldUntilL = nowMs + VU_PEAK_HOLD_MS
      }
      return
    }

    if (peakDb > this.snapshot.peakRDb) {
      this.snapshot.peakRDb = peakDb
      this.peakHoldUntilR = nowMs + VU_PEAK_HOLD_MS
    }
  }
}
