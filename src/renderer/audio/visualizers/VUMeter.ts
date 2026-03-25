import { audioEngine } from '../AudioEngine'
import { getSourceChannelId } from '../../utils/sourceChannelLayout'
import { FrameScheduler } from './frameScheduler'
import { VisualizerFrameLoop } from './visualizerFrameLoop'
import type { MultichannelAudioChunk } from '../../../types/audioAnalysis'
import {
  DEFAULT_VU_METER_ORIENTATION,
  type VUMeterMode,
  type VUMeterOrientation,
} from '../../../types/vumeter'

export interface VUMeterDataSource {
  getPendingVUMeterSamples: () => MultichannelAudioChunk[]
  getSampleRate: () => number
  isPlaying: () => boolean
}

export interface VUMeterOptions {
  mode?: VUMeterMode
  orientation?: VUMeterOrientation
  lineColor?: string
  dataSource?: VUMeterDataSource
  frameScheduler?: FrameScheduler
}

type ResolvedVUMeterOptions = Required<Omit<VUMeterOptions, 'dataSource' | 'frameScheduler'>>

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

const METER_MIN_DB = -60
const METER_MAX_DB = 0
const PEAK_HOLD_FRAMES = 45
const PEAK_DECAY_DB_PER_FRAME = 0.3
const RMS_SMOOTHING = 0.85
const CORRELATION_SMOOTHING = 0.88

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

export class VUMeter {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private options: ResolvedVUMeterOptions
  private dataSource: VUMeterDataSource
  private frameLoop: VisualizerFrameLoop
  private rmsLevels: number[] = []
  private peakLevels: number[] = []
  private peakHoldFrames: number[] = []
  private activeChannelCount = 0
  private correlation = 0
  private unsubscribeTrackChange: (() => void) | null = null
  private unsubscribePlaybackState: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement, options: VUMeterOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx

    const { dataSource, frameScheduler, ...optionOverrides } = options
    this.options = { ...defaultOptions, ...optionOverrides }
    this.dataSource = dataSource ?? defaultVUMeterDataSource
    this.frameLoop = new VisualizerFrameLoop({
      frameScheduler,
      shouldRun: () => this.dataSource.isPlaying(),
      onFrame: this.drawFrame,
    })

    this.unsubscribeTrackChange = audioEngine.onTrackChange(() => {
      this.resetMeters()
    })
    this.unsubscribePlaybackState = audioEngine.on('stateChange', () => {
      this.invalidate()
    })
  }

  private resetMeters(): void {
    this.rmsLevels = []
    this.peakLevels = []
    this.peakHoldFrames = []
    this.activeChannelCount = 0
    this.correlation = 0
    this.invalidate()
  }

  private ensureMeterState(channelCount: number): void {
    if (channelCount <= 0) return

    if (this.rmsLevels.length > channelCount) {
      this.rmsLevels.length = channelCount
      this.peakLevels.length = channelCount
      this.peakHoldFrames.length = channelCount
    }

    while (this.rmsLevels.length < channelCount) {
      this.rmsLevels.push(METER_MIN_DB)
      this.peakLevels.push(METER_MIN_DB)
      this.peakHoldFrames.push(0)
    }

    this.activeChannelCount = channelCount
  }

  setOptions(options: Partial<VUMeterOptions>): void {
    const { dataSource, frameScheduler: _frameScheduler, ...optionUpdates } = options
    this.options = { ...this.options, ...optionUpdates }
    if (dataSource) {
      this.dataSource = dataSource
    }
    this.invalidate()
  }

  start(): void {
    this.frameLoop.start()
  }

  stop(): void {
    this.frameLoop.stop()
  }

  invalidate(): void {
    this.frameLoop.invalidate()
  }

  resize(): void {
    this.invalidate()
  }

  private processAudio(): void {
    const chunks = this.dataSource.getPendingVUMeterSamples()

    if (!this.dataSource.isPlaying() || chunks.length === 0) {
      this.decayMeters()
      return
    }

    let channelCount = 0
    for (const chunk of chunks) {
      channelCount = Math.max(channelCount, chunk.channels.length)
    }

    if (channelCount === 0) return

    this.ensureMeterState(channelCount)

    const sumSquares = new Array(channelCount).fill(0)
    const sampleCounts = new Array(channelCount).fill(0)
    let sumSqLeft = 0
    let sumSqRight = 0
    let sumLeftRight = 0
    let displaySamples = 0

    for (const chunk of chunks) {
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
        const channel = chunk.channels[channelIndex]
        if (!channel || channel.length === 0) continue
        for (let i = 0; i < channel.length; i++) {
          const sample = channel[i]
          sumSquares[channelIndex] += sample * sample
        }
        sampleCounts[channelIndex] += channel.length
      }

      const leftChannel = chunk.channels[0]
      const rightChannel = chunk.channels[1] ?? leftChannel
      if (!leftChannel || !rightChannel) continue

      const length = Math.min(leftChannel.length, rightChannel.length)
      for (let i = 0; i < length; i++) {
        const leftSample = leftChannel[i]
        const rightSample = rightChannel[i]
        sumSqLeft += leftSample * leftSample
        sumSqRight += rightSample * rightSample
        sumLeftRight += leftSample * rightSample
      }
      displaySamples += length
    }

    for (let channelIndex = 0; channelIndex < channelCount; channelIndex++) {
      const sampleCount = sampleCounts[channelIndex]
      const db = sampleCount > 0
        ? 20 * Math.log10(Math.max(Math.sqrt(sumSquares[channelIndex] / sampleCount), 1e-10))
        : METER_MIN_DB
      this.rmsLevels[channelIndex] = (
        this.rmsLevels[channelIndex] * RMS_SMOOTHING
      ) + (db * (1 - RMS_SMOOTHING))
    }

    if (displaySamples > 0) {
      const denominator = Math.sqrt(sumSqLeft * sumSqRight)
      const rawCorrelation = denominator > 1e-10 ? sumLeftRight / denominator : 0
      this.correlation = this.correlation * CORRELATION_SMOOTHING + rawCorrelation * (1 - CORRELATION_SMOOTHING)
    } else {
      this.correlation = this.correlation * CORRELATION_SMOOTHING
    }

    this.updatePeaks()
  }

  private decayMeters(): void {
    for (let i = 0; i < this.activeChannelCount; i++) {
      this.rmsLevels[i] = this.rmsLevels[i] * RMS_SMOOTHING + METER_MIN_DB * (1 - RMS_SMOOTHING)
    }
    this.correlation = this.correlation * CORRELATION_SMOOTHING
    this.updatePeaks()
  }

  private updatePeaks(): void {
    for (let i = 0; i < this.activeChannelCount; i++) {
      const rms = this.rmsLevels[i]
      if (rms > this.peakLevels[i]) {
        this.peakLevels[i] = rms
        this.peakHoldFrames[i] = PEAK_HOLD_FRAMES
      } else if (this.peakHoldFrames[i] > 0) {
        this.peakHoldFrames[i]--
      } else {
        this.peakLevels[i] = Math.max(this.peakLevels[i] - PEAK_DECAY_DB_PER_FRAME, METER_MIN_DB)
      }
    }
  }

  private dbToNormalized(db: number): number {
    return Math.max(0, Math.min(1, (db - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)))
  }

  private getChannelLabel(channelIndex: number): string {
    if (this.activeChannelCount <= 1) return 'M'
    if (this.activeChannelCount === 2) return channelIndex === 0 ? 'L' : 'R'
    return getSourceChannelId(channelIndex)
  }

  private getDisplayChannelIndex(index: number): number {
    if (this.activeChannelCount <= 1) return 0
    return Math.min(index, 1)
  }

  private getRmsLevel(index: number): number {
    if (this.activeChannelCount === 0) return METER_MIN_DB
    return this.rmsLevels[this.getDisplayChannelIndex(index)] ?? METER_MIN_DB
  }

  private getPeakLevel(index: number): number {
    if (this.activeChannelCount === 0) return METER_MIN_DB
    return this.peakLevels[this.getDisplayChannelIndex(index)] ?? METER_MIN_DB
  }

  private drawBarMode(width: number, height: number): void {
    if (this.activeChannelCount <= 0) return

    if (this.options.orientation === 'vertical') {
      if (this.activeChannelCount === 2) {
        this.drawStereoVerticalBarMode(width, height)
      } else {
        this.drawMultichannelVerticalBarMode(width, height)
      }
      return
    }

    if (this.activeChannelCount === 2) {
      this.drawStereoHorizontalBarMode(width, height)
    } else {
      this.drawMultichannelHorizontalBarMode(width, height)
    }
  }

  private drawStereoHorizontalBarMode(width: number, height: number): void {
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
    const totalHeight = meterHeight * 2 + corrHeight + gap * 2
    const topOffset = Math.max(0, Math.floor((height - totalHeight) / 2))

    const leftY = topOffset
    this.drawHorizontalMeterBar(ctx, barLeft, leftY, barWidth, meterHeight, this.rmsLevels[0], this.peakLevels[0], cr, cg, cb)
    this.drawMeterLabel(ctx, 0, leftY, labelWidth, meterHeight, 'L')
    this.drawDbLabel(ctx, barRight + 4, leftY, dbLabelWidth, meterHeight, this.rmsLevels[0])

    const rightY = leftY + meterHeight + gap
    this.drawHorizontalMeterBar(ctx, barLeft, rightY, barWidth, meterHeight, this.rmsLevels[1], this.peakLevels[1], cr, cg, cb)
    this.drawMeterLabel(ctx, 0, rightY, labelWidth, meterHeight, 'R')
    this.drawDbLabel(ctx, barRight + 4, rightY, dbLabelWidth, meterHeight, this.rmsLevels[1])

    const corrY = rightY + meterHeight + gap
    this.drawCorrelationBar(ctx, barLeft, corrY, barWidth, corrHeight, cr, cg, cb)
  }

  private drawMultichannelHorizontalBarMode(width: number, height: number): void {
    const ctx = this.ctx
    const [cr, cg, cb] = parseHexColor(this.options.lineColor)

    const gap = Math.max(2, Math.floor(height * 0.035))
    const labelWidth = Math.max(26, Math.floor(width * 0.1))
    const dbLabelWidth = Math.max(50, Math.floor(width * 0.12))
    const barLeft = labelWidth + 4
    const barRight = width - dbLabelWidth - 4
    const barWidth = Math.max(1, barRight - barLeft)
    const totalGap = gap * Math.max(0, this.activeChannelCount - 1)
    const meterHeight = Math.max(1, Math.floor((height - totalGap) / this.activeChannelCount))
    const totalHeight = meterHeight * this.activeChannelCount + totalGap
    const topOffset = Math.max(0, Math.floor((height - totalHeight) / 2))

    for (let channelIndex = 0; channelIndex < this.activeChannelCount; channelIndex++) {
      const y = topOffset + (channelIndex * (meterHeight + gap))
      this.drawHorizontalMeterBar(
        ctx,
        barLeft,
        y,
        barWidth,
        meterHeight,
        this.rmsLevels[channelIndex],
        this.peakLevels[channelIndex],
        cr,
        cg,
        cb
      )
      this.drawMeterLabel(ctx, 0, y, labelWidth, meterHeight, this.getChannelLabel(channelIndex))
      this.drawDbLabel(ctx, barRight + 4, y, dbLabelWidth, meterHeight, this.rmsLevels[channelIndex])
    }
  }

  private drawStereoVerticalBarMode(width: number, height: number): void {
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

    const leftX = meterLeft
    const rightX = meterLeft + meterWidth + channelGap

    this.drawMeterLabel(ctx, leftX, 0, meterWidth, labelHeight, 'L')
    this.drawVerticalMeterBar(ctx, leftX, meterTop, meterWidth, meterHeight, this.rmsLevels[0], this.peakLevels[0], cr, cg, cb)
    this.drawCenteredDbLabel(ctx, leftX, dbY, meterWidth, dbHeight, this.rmsLevels[0])

    this.drawMeterLabel(ctx, rightX, 0, meterWidth, labelHeight, 'R')
    this.drawVerticalMeterBar(ctx, rightX, meterTop, meterWidth, meterHeight, this.rmsLevels[1], this.peakLevels[1], cr, cg, cb)
    this.drawCenteredDbLabel(ctx, rightX, dbY, meterWidth, dbHeight, this.rmsLevels[1])

    this.drawCorrelationBar(ctx, corrX, corrY, corrWidth, corrHeight, cr, cg, cb)
  }

  private drawMultichannelVerticalBarMode(width: number, height: number): void {
    const ctx = this.ctx
    const [cr, cg, cb] = parseHexColor(this.options.lineColor)
    const showDbReadouts = this.activeChannelCount === 1
    const sidePadding = Math.max(4, Math.floor(width * 0.05))
    const channelGap = Math.max(2, Math.floor(width * 0.02))
    const labelHeight = Math.max(14, Math.floor(height * 0.08))
    const dbHeight = showDbReadouts ? Math.max(14, Math.floor(height * 0.08)) : 0
    const gapY = Math.max(4, Math.floor(height * 0.03))
    const totalGapWidth = channelGap * Math.max(0, this.activeChannelCount - 1)
    const availableMeterWidth = Math.max(8, width - sidePadding * 2 - totalGapWidth)
    const meterWidth = Math.max(4, Math.floor(availableMeterWidth / this.activeChannelCount))
    const totalMeterWidth = meterWidth * this.activeChannelCount + totalGapWidth
    const meterLeft = Math.max(0, Math.floor((width - totalMeterWidth) / 2))
    const meterTop = gapY + labelHeight
    const meterHeight = Math.max(1, height - labelHeight - gapY * 2 - (showDbReadouts ? (dbHeight + gapY) : 0))
    const dbY = meterTop + meterHeight + gapY

    for (let channelIndex = 0; channelIndex < this.activeChannelCount; channelIndex++) {
      const x = meterLeft + (channelIndex * (meterWidth + channelGap))
      this.drawMeterLabel(ctx, x, 0, meterWidth, labelHeight, this.getChannelLabel(channelIndex))
      this.drawVerticalMeterBar(
        ctx,
        x,
        meterTop,
        meterWidth,
        meterHeight,
        this.rmsLevels[channelIndex],
        this.peakLevels[channelIndex],
        cr,
        cg,
        cb
      )
      if (showDbReadouts) {
        this.drawCenteredDbLabel(ctx, x, dbY, meterWidth, dbHeight, this.rmsLevels[channelIndex])
      }
    }
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

    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)'
    ctx.fillRect(x, y, w, h)

    if (rmsWidth > 0) {
      const safeWidth = Math.min(rmsWidth, hotThreshold)
      if (safeWidth > 0) {
        ctx.fillStyle = colorWithAlpha(cr, cg, cb, 0.82)
        ctx.fillRect(x, y, safeWidth, h)
      }
      if (rmsWidth > hotThreshold) {
        const hotWidth = rmsWidth - hotThreshold
        const hotProgress = Math.min(1, hotWidth / Math.max(1, w - hotThreshold))
        const hotR = Math.round(cr + (255 - cr) * hotProgress * 0.7)
        const hotG = Math.round(cg * (1 - hotProgress * 0.6))
        const hotB = Math.round(cb * (1 - hotProgress * 0.7))
        ctx.fillStyle = colorWithAlpha(hotR, hotG, hotB, 0.82)
        ctx.fillRect(x + hotThreshold, y, hotWidth, h)
      }
    }

    if (peakNorm > 0.001) {
      const peakX = x + peakNorm * w
      const peakInHot = peakDb > -6
      ctx.fillStyle = peakInHot
        ? 'rgba(255, 120, 80, 0.9)'
        : colorWithAlpha(cr, cg, cb, 0.9)
      ctx.fillRect(peakX - 1, y, 2, h)
    }

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

    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)'
    ctx.fillRect(x, y, w, h)

    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)'
    ctx.fillRect(centerX - 0.5, y, 1, h)

    const indicatorWidth = Math.abs(corr) * (w / 2)
    if (indicatorWidth > 0.5) {
      if (corr >= 0) {
        ctx.fillStyle = colorWithAlpha(cr, cg, cb, 0.6)
        ctx.fillRect(centerX, y, indicatorWidth, h)
      } else {
        ctx.fillStyle = 'rgba(255, 120, 80, 0.6)'
        ctx.fillRect(centerX - indicatorWidth, y, indicatorWidth, h)
      }
    }

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
    const corrHeight = Math.max(1, Math.floor(height * 0.12))
    const gap = Math.max(2, Math.floor(height * 0.03))
    const meterAreaHeight = height - corrHeight - gap
    const meterWidth = Math.floor(width / 2) - 2
    const barLeft = Math.max(16, Math.floor(width * 0.06)) + 4
    const barRight = width - Math.max(36, Math.floor(width * 0.08)) - 4
    const barWidth = Math.max(1, barRight - barLeft)
    const leftRms = this.getRmsLevel(0)
    const leftPeak = this.getPeakLevel(0)
    const rightRms = this.getRmsLevel(1)
    const rightPeak = this.getPeakLevel(1)

    this.drawNeedleMeter(ctx, 0, 0, meterWidth, meterAreaHeight, leftRms, leftPeak, 'L', cr, cg, cb)
    this.drawNeedleMeter(ctx, meterWidth + 4, 0, meterWidth, meterAreaHeight, rightRms, rightPeak, 'R', cr, cg, cb)
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
    const startAngle = Math.PI * 1.25
    const endAngle = Math.PI * 1.75

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(centerX, arcCenterY, arcRadius, startAngle, endAngle)
    ctx.stroke()

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

    ctx.fillStyle = colorWithAlpha(cr, cg, cb, 0.7)
    ctx.beginPath()
    ctx.arc(centerX, arcCenterY, 2.5, 0, Math.PI * 2)
    ctx.fill()

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

    const fontSize = Math.min(22, Math.max(10, h * 0.1))
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)'
    ctx.font = `${fontSize}px "JetBrains Mono", monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(label, centerX, y + 4)

    const displayDb = Math.max(METER_MIN_DB, Math.min(0, rmsDb))
    const dbText = displayDb <= METER_MIN_DB + 1 ? '-∞ dB' : `${displayDb.toFixed(1)} dB`
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)'
    ctx.font = `${Math.max(9, fontSize - 1)}px "JetBrains Mono", monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(dbText, centerX, y + h - 2)
  }

  private drawFrame = (): void => {
    const { canvas, ctx, options } = this
    const width = canvas.width
    const height = canvas.height

    if (width <= 0 || height <= 0) {
      return
    }

    this.processAudio()
    ctx.clearRect(0, 0, width, height)

    if (options.mode === 'needle') {
      this.drawNeedleMode(width, height)
    } else {
      this.drawBarMode(width, height)
    }
  }

  dispose(): void {
    this.stop()
    if (this.unsubscribeTrackChange) {
      this.unsubscribeTrackChange()
      this.unsubscribeTrackChange = null
    }
    if (this.unsubscribePlaybackState) {
      this.unsubscribePlaybackState()
      this.unsubscribePlaybackState = null
    }
  }
}
