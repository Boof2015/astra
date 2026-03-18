import { audioEngine } from '../AudioEngine'
import {
  DEFAULT_VU_METER_ORIENTATION,
  type VUMeterMode,
  type VUMeterOrientation,
} from '../../../types/vumeter'

export interface VUMeterDataSource {
  getPendingVUMeterSamples: () => Array<{ left: Float32Array; right: Float32Array }>
  getSampleRate: () => number
  isPlaying: () => boolean
}

export interface VUMeterOptions {
  mode?: VUMeterMode
  orientation?: VUMeterOrientation
  lineColor?: string
  dataSource?: VUMeterDataSource
}

type ResolvedVUMeterOptions = Required<Omit<VUMeterOptions, 'dataSource'>>

const defaultOptions: ResolvedVUMeterOptions = {
  mode: 'bar',
  orientation: DEFAULT_VU_METER_ORIENTATION,
  lineColor: '#38bdf8',
}

const defaultVUMeterDataSource: VUMeterDataSource = {
  getPendingVUMeterSamples: () => audioEngine.flushPendingVUMeterSamples(),
  getSampleRate: () => audioEngine.getSampleRate(),
  isPlaying: () => audioEngine.playbackState === 'playing',
}

// ---- Meter constants ----

const METER_MIN_DB = -60
const METER_MAX_DB = 0
const PEAK_HOLD_FRAMES = 45 // ~0.75s at 60fps
const PEAK_DECAY_DB_PER_FRAME = 0.3
const RMS_SMOOTHING = 0.85 // exponential smoothing factor
const CORRELATION_SMOOTHING = 0.88

// ---- Color utilities ----

function parseHexColor(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.substring(0, 2), 16) || 56,
    parseInt(h.substring(2, 4), 16) || 189,
    parseInt(h.substring(4, 6), 16) || 248,
  ]
}

function colorWithAlpha(r: number, g: number, b: number, a: number): string {
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

// ---- VU Meter class ----

export class VUMeter {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private options: ResolvedVUMeterOptions
  private dataSource: VUMeterDataSource
  private animationId: number | null = null
  private isRunning = false

  // Meter state
  private rmsL = METER_MIN_DB
  private rmsR = METER_MIN_DB
  private peakL = METER_MIN_DB
  private peakR = METER_MIN_DB
  private peakHoldL = 0
  private peakHoldR = 0
  private correlation = 0

  // Track change subscription
  private unsubscribeTrackChange: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement, options: VUMeterOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx

    const { dataSource, ...optionOverrides } = options
    this.options = { ...defaultOptions, ...optionOverrides }
    this.dataSource = dataSource ?? defaultVUMeterDataSource

    this.unsubscribeTrackChange = audioEngine.onTrackChange(() => {
      this.resetMeters()
    })
  }

  private resetMeters(): void {
    this.rmsL = METER_MIN_DB
    this.rmsR = METER_MIN_DB
    this.peakL = METER_MIN_DB
    this.peakR = METER_MIN_DB
    this.peakHoldL = 0
    this.peakHoldR = 0
    this.correlation = 0
  }

  setOptions(options: Partial<VUMeterOptions>): void {
    const { dataSource, ...optionUpdates } = options
    this.options = { ...this.options, ...optionUpdates }
    if (dataSource) {
      this.dataSource = dataSource
    }
  }

  start(): void {
    if (this.isRunning) return
    this.isRunning = true
    this.draw()
  }

  stop(): void {
    this.isRunning = false
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId)
      this.animationId = null
    }
  }

  resize(): void {
    // Canvas resize handled externally
  }

  private processAudio(): void {
    const chunks = this.dataSource.getPendingVUMeterSamples()

    if (!this.dataSource.isPlaying() || chunks.length === 0) {
      // Decay toward silence
      this.rmsL = this.rmsL * RMS_SMOOTHING + METER_MIN_DB * (1 - RMS_SMOOTHING)
      this.rmsR = this.rmsR * RMS_SMOOTHING + METER_MIN_DB * (1 - RMS_SMOOTHING)
      this.correlation = this.correlation * CORRELATION_SMOOTHING
      this.updatePeaks()
      return
    }

    // Compute RMS and correlation across all chunks
    let sumSqL = 0
    let sumSqR = 0
    let sumLR = 0
    let totalSamples = 0

    for (const chunk of chunks) {
      const len = Math.min(chunk.left.length, chunk.right.length)
      for (let i = 0; i < len; i++) {
        const l = chunk.left[i]
        const r = chunk.right[i]
        sumSqL += l * l
        sumSqR += r * r
        sumLR += l * r
      }
      totalSamples += len
    }

    if (totalSamples === 0) return

    const rawRmsL = Math.sqrt(sumSqL / totalSamples)
    const rawRmsR = Math.sqrt(sumSqR / totalSamples)
    const dbL = 20 * Math.log10(Math.max(rawRmsL, 1e-10))
    const dbR = 20 * Math.log10(Math.max(rawRmsR, 1e-10))

    // Smooth RMS values
    this.rmsL = this.rmsL * RMS_SMOOTHING + dbL * (1 - RMS_SMOOTHING)
    this.rmsR = this.rmsR * RMS_SMOOTHING + dbR * (1 - RMS_SMOOTHING)

    // Compute correlation coefficient: sum(L*R) / sqrt(sum(L^2) * sum(R^2))
    const denominator = Math.sqrt(sumSqL * sumSqR)
    const rawCorrelation = denominator > 1e-10 ? sumLR / denominator : 0
    this.correlation = this.correlation * CORRELATION_SMOOTHING + rawCorrelation * (1 - CORRELATION_SMOOTHING)

    this.updatePeaks()
  }

  private updatePeaks(): void {
    // Update peak hold for L
    if (this.rmsL > this.peakL) {
      this.peakL = this.rmsL
      this.peakHoldL = PEAK_HOLD_FRAMES
    } else if (this.peakHoldL > 0) {
      this.peakHoldL--
    } else {
      this.peakL = Math.max(this.peakL - PEAK_DECAY_DB_PER_FRAME, METER_MIN_DB)
    }

    // Update peak hold for R
    if (this.rmsR > this.peakR) {
      this.peakR = this.rmsR
      this.peakHoldR = PEAK_HOLD_FRAMES
    } else if (this.peakHoldR > 0) {
      this.peakHoldR--
    } else {
      this.peakR = Math.max(this.peakR - PEAK_DECAY_DB_PER_FRAME, METER_MIN_DB)
    }
  }

  private dbToNormalized(db: number): number {
    return Math.max(0, Math.min(1, (db - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)))
  }

  private drawBarMode(width: number, height: number): void {
    if (this.options.orientation === 'vertical') {
      this.drawVerticalBarMode(width, height)
      return
    }

    this.drawHorizontalBarMode(width, height)
  }

  private drawHorizontalBarMode(width: number, height: number): void {
    const ctx = this.ctx
    const [cr, cg, cb] = parseHexColor(this.options.lineColor)

    const meterHeight = Math.max(1, Math.floor(height * 0.28))
    const corrHeight = Math.max(1, Math.floor(height * 0.16))
    const gap = Math.max(2, Math.floor(height * 0.04))
    const labelWidth = Math.max(24, Math.floor(width * 0.07))
    const dbLabelWidth = Math.max(52, Math.floor(width * 0.1))
    const barLeft = labelWidth + 4
    const barRight = width - dbLabelWidth - 4
    const barWidth = Math.max(1, barRight - barLeft)

    // Total content height
    const totalHeight = meterHeight * 2 + corrHeight + gap * 2
    const topOffset = Math.max(0, Math.floor((height - totalHeight) / 2))

    // ---- L meter ----
    const lY = topOffset
    this.drawHorizontalMeterBar(ctx, barLeft, lY, barWidth, meterHeight, this.rmsL, this.peakL, cr, cg, cb)
    this.drawMeterLabel(ctx, 0, lY, labelWidth, meterHeight, 'L')
    this.drawDbLabel(ctx, barRight + 4, lY, dbLabelWidth, meterHeight, this.rmsL)

    // ---- R meter ----
    const rY = lY + meterHeight + gap
    this.drawHorizontalMeterBar(ctx, barLeft, rY, barWidth, meterHeight, this.rmsR, this.peakR, cr, cg, cb)
    this.drawMeterLabel(ctx, 0, rY, labelWidth, meterHeight, 'R')
    this.drawDbLabel(ctx, barRight + 4, rY, dbLabelWidth, meterHeight, this.rmsR)

    // ---- Correlation meter ----
    const corrY = rY + meterHeight + gap
    this.drawCorrelationBar(ctx, barLeft, corrY, barWidth, corrHeight, cr, cg, cb)
  }

  private drawVerticalBarMode(width: number, height: number): void {
    const ctx = this.ctx
    const [cr, cg, cb] = parseHexColor(this.options.lineColor)

    const sidePadding = Math.max(4, Math.floor(width * 0.08))
    const channelGap = Math.max(4, Math.floor(width * 0.08))
    const labelHeight = Math.max(14, Math.floor(height * 0.08))
    const dbHeight = Math.max(14, Math.floor(height * 0.1))
    const corrHeight = Math.max(10, Math.floor(height * 0.11))
    const gapY = Math.max(4, Math.floor(height * 0.03))
    const maxMeterWidth = Math.max(4, Math.floor((width - channelGap) / 2))
    const availableMeterWidth = Math.max(8, width - sidePadding * 2 - channelGap)
    const meterWidth = Math.min(Math.max(6, Math.floor(availableMeterWidth / 2)), maxMeterWidth)
    const totalMeterWidth = meterWidth * 2 + channelGap
    const meterLeft = Math.max(0, Math.floor((width - totalMeterWidth) / 2))
    const meterTop = gapY + labelHeight
    const meterHeight = Math.max(1, height - labelHeight - dbHeight - corrHeight - gapY * 4)
    const dbY = meterTop + meterHeight + gapY
    const corrY = dbY + dbHeight + gapY
    const corrX = Math.max(4, Math.floor(width * 0.06))
    const corrWidth = Math.max(1, width - corrX * 2)

    const lX = meterLeft
    const rX = meterLeft + meterWidth + channelGap

    this.drawMeterLabel(ctx, lX, 0, meterWidth, labelHeight, 'L')
    this.drawVerticalMeterBar(ctx, lX, meterTop, meterWidth, meterHeight, this.rmsL, this.peakL, cr, cg, cb)
    this.drawCenteredDbLabel(ctx, lX, dbY, meterWidth, dbHeight, this.rmsL)

    this.drawMeterLabel(ctx, rX, 0, meterWidth, labelHeight, 'R')
    this.drawVerticalMeterBar(ctx, rX, meterTop, meterWidth, meterHeight, this.rmsR, this.peakR, cr, cg, cb)
    this.drawCenteredDbLabel(ctx, rX, dbY, meterWidth, dbHeight, this.rmsR)

    this.drawCorrelationBar(ctx, corrX, corrY, corrWidth, corrHeight, cr, cg, cb)
  }

  private drawHorizontalMeterBar(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    rmsDb: number, peakDb: number,
    cr: number, cg: number, cb: number
  ): void {
    const rmsNorm = this.dbToNormalized(rmsDb)
    const peakNorm = this.dbToNormalized(peakDb)
    const rmsWidth = rmsNorm * w
    const hotThreshold = this.dbToNormalized(-6) * w

    // Background track
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)'
    ctx.fillRect(x, y, w, h)

    // RMS bar
    if (rmsWidth > 0) {
      const safeWidth = Math.min(rmsWidth, hotThreshold)
      if (safeWidth > 0) {
        ctx.fillStyle = colorWithAlpha(cr, cg, cb, 0.82)
        ctx.fillRect(x, y, safeWidth, h)
      }
      if (rmsWidth > hotThreshold) {
        // Hot zone: transition to warm/red
        const hotWidth = rmsWidth - hotThreshold
        const hotProgress = Math.min(1, hotWidth / Math.max(1, w - hotThreshold))
        const hotR = Math.round(cr + (255 - cr) * hotProgress * 0.7)
        const hotG = Math.round(cg * (1 - hotProgress * 0.6))
        const hotB = Math.round(cb * (1 - hotProgress * 0.7))
        ctx.fillStyle = colorWithAlpha(hotR, hotG, hotB, 0.82)
        ctx.fillRect(x + hotThreshold, y, hotWidth, h)
      }
    }

    // Peak indicator line
    if (peakNorm > 0.001) {
      const peakX = x + peakNorm * w
      const peakInHot = peakDb > -6
      ctx.fillStyle = peakInHot
        ? 'rgba(255, 120, 80, 0.9)'
        : colorWithAlpha(cr, cg, cb, 0.9)
      ctx.fillRect(peakX - 1, y, 2, h)
    }

    // Scale ticks
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)'
    const tickDbs = [-48, -36, -24, -18, -12, -6, -3, 0]
    for (const db of tickDbs) {
      const tickX = x + this.dbToNormalized(db) * w
      ctx.fillRect(tickX, y + h - 3, 1, 3)
    }
  }

  private drawVerticalMeterBar(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    rmsDb: number, peakDb: number,
    cr: number, cg: number, cb: number
  ): void {
    const rmsNorm = this.dbToNormalized(rmsDb)
    const peakNorm = this.dbToNormalized(peakDb)
    const rmsHeight = rmsNorm * h
    const hotThreshold = this.dbToNormalized(-6) * h

    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)'
    ctx.fillRect(x, y, w, h)

    if (rmsHeight > 0) {
      const safeHeight = Math.min(rmsHeight, hotThreshold)
      if (safeHeight > 0) {
        ctx.fillStyle = colorWithAlpha(cr, cg, cb, 0.82)
        ctx.fillRect(x, y + h - safeHeight, w, safeHeight)
      }
      if (rmsHeight > hotThreshold) {
        const hotHeight = rmsHeight - hotThreshold
        const hotProgress = Math.min(1, hotHeight / Math.max(1, h - hotThreshold))
        const hotR = Math.round(cr + (255 - cr) * hotProgress * 0.7)
        const hotG = Math.round(cg * (1 - hotProgress * 0.6))
        const hotB = Math.round(cb * (1 - hotProgress * 0.7))
        ctx.fillStyle = colorWithAlpha(hotR, hotG, hotB, 0.82)
        ctx.fillRect(x, y + h - rmsHeight, w, hotHeight)
      }
    }

    if (peakNorm > 0.001) {
      const peakY = y + h - peakNorm * h
      const peakInHot = peakDb > -6
      ctx.fillStyle = peakInHot
        ? 'rgba(255, 120, 80, 0.9)'
        : colorWithAlpha(cr, cg, cb, 0.9)
      ctx.fillRect(x, peakY - 1, w, 2)
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)'
    const tickDbs = [-48, -36, -24, -18, -12, -6, -3, 0]
    for (const db of tickDbs) {
      const tickY = y + h - this.dbToNormalized(db) * h
      ctx.fillRect(x, tickY, w, 1)
    }
  }

  private drawMeterLabel(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    label: string
  ): void {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)'
    ctx.font = `${Math.min(22, Math.max(10, h * 0.65))}px "JetBrains Mono", monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, x + w / 2, y + h / 2)
  }

  private drawDbLabel(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, _w: number, h: number,
    db: number
  ): void {
    const displayDb = Math.max(METER_MIN_DB, Math.min(0, db))
    const text = displayDb <= METER_MIN_DB + 1 ? '-∞' : `${displayDb.toFixed(1)}`
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)'
    ctx.font = `${Math.min(20, Math.max(9, h * 0.55))}px "JetBrains Mono", monospace`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x, y + h / 2)
  }

  private drawCenteredDbLabel(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    db: number
  ): void {
    const displayDb = Math.max(METER_MIN_DB, Math.min(0, db))
    const text = displayDb <= METER_MIN_DB + 1 ? '-∞' : `${displayDb.toFixed(1)}`
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)'
    ctx.font = `${Math.min(16, Math.max(8, h * 0.5))}px "JetBrains Mono", monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x + w / 2, y + h / 2)
  }

  private drawCorrelationBar(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    cr: number, cg: number, cb: number
  ): void {
    const centerX = x + w / 2
    const corr = Math.max(-1, Math.min(1, this.correlation))

    // Background track
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)'
    ctx.fillRect(x, y, w, h)

    // Center line
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)'
    ctx.fillRect(centerX - 0.5, y, 1, h)

    // Correlation indicator
    const indicatorWidth = Math.abs(corr) * (w / 2)
    if (indicatorWidth > 0.5) {
      if (corr >= 0) {
        // Positive correlation: draw rightward from center (good)
        ctx.fillStyle = colorWithAlpha(cr, cg, cb, 0.6)
        ctx.fillRect(centerX, y, indicatorWidth, h)
      } else {
        // Negative correlation: draw leftward from center (out of phase)
        ctx.fillStyle = 'rgba(255, 120, 80, 0.6)'
        ctx.fillRect(centerX - indicatorWidth, y, indicatorWidth, h)
      }
    }

    // Labels
    const fontSize = Math.min(18, Math.max(8, h * 0.55))
    ctx.font = `${fontSize}px "JetBrains Mono", monospace`
    ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)'
    ctx.textAlign = 'left'
    ctx.fillText('-1', x + 2, y + h / 2)
    ctx.textAlign = 'center'
    ctx.fillText('Ø', centerX, y + h / 2)
    ctx.textAlign = 'right'
    ctx.fillText('+1', x + w - 2, y + h / 2)
  }

  private drawNeedleMode(width: number, height: number): void {
    const ctx = this.ctx
    const [cr, cg, cb] = parseHexColor(this.options.lineColor)

    // Layout: two meters side by side, correlation bar below
    const corrHeight = Math.max(1, Math.floor(height * 0.12))
    const gap = Math.max(2, Math.floor(height * 0.03))
    const meterAreaHeight = height - corrHeight - gap
    const meterWidth = Math.floor(width / 2) - 2
    const barLeft = Math.max(16, Math.floor(width * 0.06)) + 4
    const barRight = width - Math.max(36, Math.floor(width * 0.08)) - 4
    const barWidth = Math.max(1, barRight - barLeft)

    // L needle
    this.drawNeedleMeter(ctx, 0, 0, meterWidth, meterAreaHeight, this.rmsL, this.peakL, 'L', cr, cg, cb)
    // R needle
    this.drawNeedleMeter(ctx, meterWidth + 4, 0, meterWidth, meterAreaHeight, this.rmsR, this.peakR, 'R', cr, cg, cb)

    // Correlation bar at bottom
    this.drawCorrelationBar(ctx, barLeft, meterAreaHeight + gap, barWidth, corrHeight, cr, cg, cb)
  }

  private drawNeedleMeter(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    rmsDb: number, peakDb: number,
    label: string,
    cr: number, cg: number, cb: number
  ): void {
    const centerX = x + w / 2
    const arcRadius = Math.min(w * 0.42, h * 0.65)
    const arcCenterY = y + h * 0.78

    // Arc background (sweep from -135° to -45°, top half)
    const startAngle = Math.PI * 1.25 // 225° (bottom-left)
    const endAngle = Math.PI * 1.75 // 315° (bottom-right)

    // Scale arc
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(centerX, arcCenterY, arcRadius, startAngle, endAngle)
    ctx.stroke()

    // Scale ticks
    const tickDbs = [-48, -36, -24, -18, -12, -6, -3, 0]
    for (const db of tickDbs) {
      const norm = this.dbToNormalized(db)
      const angle = startAngle + norm * (endAngle - startAngle)
      const innerR = arcRadius - 6
      const outerR = arcRadius + 2

      ctx.strokeStyle = db >= -6
        ? 'rgba(255, 120, 80, 0.3)'
        : 'rgba(255, 255, 255, 0.15)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(centerX + Math.cos(angle) * innerR, arcCenterY + Math.sin(angle) * innerR)
      ctx.lineTo(centerX + Math.cos(angle) * outerR, arcCenterY + Math.sin(angle) * outerR)
      ctx.stroke()
    }

    // Needle
    const rmsNorm = this.dbToNormalized(rmsDb)
    const needleAngle = startAngle + rmsNorm * (endAngle - startAngle)
    const needleLength = arcRadius * 0.88

    ctx.strokeStyle = colorWithAlpha(cr, cg, cb, 0.9)
    ctx.lineWidth = 1.5
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(centerX, arcCenterY)
    ctx.lineTo(
      centerX + Math.cos(needleAngle) * needleLength,
      arcCenterY + Math.sin(needleAngle) * needleLength
    )
    ctx.stroke()

    // Needle pivot dot
    ctx.fillStyle = colorWithAlpha(cr, cg, cb, 0.7)
    ctx.beginPath()
    ctx.arc(centerX, arcCenterY, 2.5, 0, Math.PI * 2)
    ctx.fill()

    // Peak indicator (small dot on the arc)
    const peakNorm = this.dbToNormalized(peakDb)
    if (peakNorm > 0.001) {
      const peakAngle = startAngle + peakNorm * (endAngle - startAngle)
      const peakInHot = peakDb > -6
      ctx.fillStyle = peakInHot
        ? 'rgba(255, 120, 80, 0.8)'
        : colorWithAlpha(cr, cg, cb, 0.8)
      ctx.beginPath()
      ctx.arc(
        centerX + Math.cos(peakAngle) * arcRadius,
        arcCenterY + Math.sin(peakAngle) * arcRadius,
        2.5, 0, Math.PI * 2
      )
      ctx.fill()
    }

    // Channel label
    const fontSize = Math.min(22, Math.max(10, h * 0.1))
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)'
    ctx.font = `${fontSize}px "JetBrains Mono", monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(label, centerX, y + 4)

    // dB readout
    const displayDb = Math.max(METER_MIN_DB, Math.min(0, rmsDb))
    const dbText = displayDb <= METER_MIN_DB + 1 ? '-∞ dB' : `${displayDb.toFixed(1)} dB`
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)'
    ctx.font = `${Math.max(9, fontSize - 1)}px "JetBrains Mono", monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(dbText, centerX, y + h - 2)
  }

  private draw = (): void => {
    if (!this.isRunning) return

    const { canvas, ctx, options } = this
    const width = canvas.width
    const height = canvas.height

    if (width <= 0 || height <= 0) {
      this.animationId = requestAnimationFrame(this.draw)
      return
    }

    this.processAudio()

    ctx.clearRect(0, 0, width, height)

    if (options.mode === 'needle') {
      this.drawNeedleMode(width, height)
    } else {
      this.drawBarMode(width, height)
    }

    this.animationId = requestAnimationFrame(this.draw)
  }

  dispose(): void {
    this.stop()
    if (this.unsubscribeTrackChange) {
      this.unsubscribeTrackChange()
      this.unsubscribeTrackChange = null
    }
  }
}
