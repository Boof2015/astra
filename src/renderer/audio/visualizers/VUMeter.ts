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
const MONO_FONT_FAMILY = '"JetBrains Mono", monospace'
const TEXT_PADDING_X_PX = 4
const TEXT_PADDING_Y_PX = 3
const CHANNEL_LABEL_MIN_FONT_PX = 8
const CHANNEL_LABEL_MAX_FONT_PX = 14
const DB_LABEL_MIN_FONT_PX = 7
const DB_LABEL_MAX_FONT_PX = 12
const CORRELATION_LABEL_MIN_FONT_PX = 7
const CORRELATION_LABEL_MAX_FONT_PX = 11
const MIN_HORIZONTAL_BAR_WIDTH_PX = 24
const MIN_VERTICAL_DB_METER_WIDTH_PX = 22

type TextRole = 'channel' | 'db' | 'correlation'

interface TextRoleSpec {
  minFontSize: number
  maxFontSize: number
  paddingX: number
  paddingY: number
}

interface FittedTextMetrics {
  fontSize: number
  textWidth: number
  bandWidth: number
  bandHeight: number
  paddingX: number
  paddingY: number
}

const TEXT_ROLE_SPECS: Record<TextRole, TextRoleSpec> = {
  channel: {
    minFontSize: CHANNEL_LABEL_MIN_FONT_PX,
    maxFontSize: CHANNEL_LABEL_MAX_FONT_PX,
    paddingX: TEXT_PADDING_X_PX,
    paddingY: TEXT_PADDING_Y_PX,
  },
  db: {
    minFontSize: DB_LABEL_MIN_FONT_PX,
    maxFontSize: DB_LABEL_MAX_FONT_PX,
    paddingX: TEXT_PADDING_X_PX,
    paddingY: TEXT_PADDING_Y_PX,
  },
  correlation: {
    minFontSize: CORRELATION_LABEL_MIN_FONT_PX,
    maxFontSize: CORRELATION_LABEL_MAX_FONT_PX,
    paddingX: TEXT_PADDING_X_PX,
    paddingY: TEXT_PADDING_Y_PX,
  },
}

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
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

  private getChannelLabels(): string[] {
    return Array.from({ length: this.activeChannelCount }, (_, channelIndex) => this.getChannelLabel(channelIndex))
  }

  private getMonoFont(fontSize: number): string {
    return `${fontSize}px ${MONO_FONT_FAMILY}`
  }

  private getDbText(db: number, includeUnit = false): string {
    const displayDb = Math.max(METER_MIN_DB, Math.min(0, db))
    const text = displayDb <= METER_MIN_DB + 1 ? '-∞' : `${displayDb.toFixed(1)}`
    return includeUnit ? `${text} dB` : text
  }

  private getStableDbText(includeUnit = false): string {
    return includeUnit ? '-60.0 dB' : '-60.0'
  }

  private fitTextBand(
    texts: readonly string[],
    maxWidth: number,
    maxHeight: number,
    role: TextRole
  ): FittedTextMetrics | null {
    if (texts.length === 0) return null

    const spec = TEXT_ROLE_SPECS[role]
    const innerMaxWidth = Math.max(0, maxWidth - spec.paddingX * 2)
    const innerMaxHeight = Math.max(0, maxHeight - spec.paddingY * 2)
    const startingFontSize = Math.min(spec.maxFontSize, Math.floor(innerMaxHeight))

    if (innerMaxWidth <= 0 || startingFontSize < spec.minFontSize) {
      return null
    }

    for (let fontSize = startingFontSize; fontSize >= spec.minFontSize; fontSize--) {
      this.ctx.font = this.getMonoFont(fontSize)
      let widestText = 0
      for (const text of texts) {
        widestText = Math.max(widestText, this.ctx.measureText(text).width)
      }
      if (widestText <= innerMaxWidth + 0.01) {
        return {
          fontSize,
          textWidth: widestText,
          bandWidth: widestText + spec.paddingX * 2,
          bandHeight: fontSize + spec.paddingY * 2,
          paddingX: spec.paddingX,
          paddingY: spec.paddingY,
        }
      }
    }

    return null
  }

  private resolveHorizontalTextLayout(
    width: number,
    meterHeight: number,
    channelTexts: readonly string[]
  ): {
    labelMetrics: FittedTextMetrics | null
    labelWidth: number
    labelGap: number
    dbMetrics: FittedTextMetrics | null
    dbWidth: number
    dbGap: number
    barLeft: number
    barRight: number
    barWidth: number
  } {
    const gapX = 4
    const minBarWidth = Math.min(width, MIN_HORIZONTAL_BAR_WIDTH_PX)
    const maxTextWidth = Math.max(0, width - minBarWidth - gapX * 2)

    let labelMetrics = this.fitTextBand(channelTexts, maxTextWidth, meterHeight, 'channel')
    let dbMetrics = this.fitTextBand([this.getStableDbText()], maxTextWidth, meterHeight, 'db')

    if (labelMetrics && dbMetrics && labelMetrics.bandWidth + dbMetrics.bandWidth > maxTextWidth) {
      dbMetrics = null
    }

    const availableLabelWidth = Math.max(0, maxTextWidth - (dbMetrics?.bandWidth ?? 0))
    if (!labelMetrics || labelMetrics.bandWidth > availableLabelWidth) {
      const fittedLabelWithDb = this.fitTextBand(channelTexts, availableLabelWidth, meterHeight, 'channel')
      if (fittedLabelWithDb) {
        labelMetrics = fittedLabelWithDb
      } else if (dbMetrics) {
        dbMetrics = null
        labelMetrics = this.fitTextBand(channelTexts, maxTextWidth, meterHeight, 'channel')
      } else {
        labelMetrics = fittedLabelWithDb
      }
    }

    if (labelMetrics && dbMetrics && labelMetrics.bandWidth + dbMetrics.bandWidth > maxTextWidth) {
      dbMetrics = null
      labelMetrics = this.fitTextBand(channelTexts, maxTextWidth, meterHeight, 'channel')
    }

    const labelWidth = labelMetrics ? Math.ceil(labelMetrics.bandWidth) : 0
    const dbWidth = dbMetrics ? Math.ceil(dbMetrics.bandWidth) : 0
    const labelGap = labelWidth > 0 ? gapX : 0
    const dbGap = dbWidth > 0 ? gapX : 0
    const barLeft = labelWidth + labelGap
    const barRight = width - dbWidth - dbGap

    return {
      labelMetrics,
      labelWidth,
      labelGap,
      dbMetrics,
      dbWidth,
      dbGap,
      barLeft,
      barRight,
      barWidth: Math.max(1, barRight - barLeft),
    }
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
    const corrHeight = Math.max(
      10,
      Math.ceil(this.fitTextBand(['-1', 'Ø', '+1'], Math.max(1, width / 3), height, 'correlation')?.bandHeight
        ?? (CORRELATION_LABEL_MIN_FONT_PX + TEXT_PADDING_Y_PX * 2))
    )
    const gap = clamp(height * 0.04, 2, 10)
    const {
      labelMetrics,
      labelWidth,
      dbMetrics,
      dbWidth,
      dbGap,
      barLeft,
      barRight,
      barWidth,
    } = this.resolveHorizontalTextLayout(width, meterHeight, ['L', 'R'])
    const totalHeight = meterHeight * 2 + corrHeight + gap * 2
    const topOffset = Math.max(0, Math.floor((height - totalHeight) / 2))

    const leftY = topOffset
    this.drawHorizontalMeterBar(ctx, barLeft, leftY, barWidth, meterHeight, this.rmsLevels[0], this.peakLevels[0], cr, cg, cb)
    if (labelMetrics && labelWidth > 0) {
      this.drawMeterLabel(ctx, 0, leftY, labelWidth, meterHeight, 'L', labelMetrics)
    }
    if (dbMetrics && dbWidth > 0) {
      this.drawDbLabel(ctx, barRight + dbGap, leftY, dbWidth, meterHeight, this.rmsLevels[0], dbMetrics)
    }

    const rightY = leftY + meterHeight + gap
    this.drawHorizontalMeterBar(ctx, barLeft, rightY, barWidth, meterHeight, this.rmsLevels[1], this.peakLevels[1], cr, cg, cb)
    if (labelMetrics && labelWidth > 0) {
      this.drawMeterLabel(ctx, 0, rightY, labelWidth, meterHeight, 'R', labelMetrics)
    }
    if (dbMetrics && dbWidth > 0) {
      this.drawDbLabel(ctx, barRight + dbGap, rightY, dbWidth, meterHeight, this.rmsLevels[1], dbMetrics)
    }

    const corrY = rightY + meterHeight + gap
    this.drawCorrelationBar(ctx, barLeft, corrY, barWidth, corrHeight, cr, cg, cb)
  }

  private drawMultichannelHorizontalBarMode(width: number, height: number): void {
    const ctx = this.ctx
    const [cr, cg, cb] = parseHexColor(this.options.lineColor)

    const gap = clamp(height * 0.035, 2, 8)
    const totalGap = gap * Math.max(0, this.activeChannelCount - 1)
    const meterHeight = Math.max(1, Math.floor((height - totalGap) / this.activeChannelCount))
    const {
      labelMetrics,
      labelWidth,
      dbMetrics,
      dbWidth,
      dbGap,
      barLeft,
      barRight,
      barWidth,
    } = this.resolveHorizontalTextLayout(width, meterHeight, this.getChannelLabels())
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
      if (labelMetrics && labelWidth > 0) {
        this.drawMeterLabel(ctx, 0, y, labelWidth, meterHeight, this.getChannelLabel(channelIndex), labelMetrics)
      }
      if (dbMetrics && dbWidth > 0) {
        this.drawDbLabel(ctx, barRight + dbGap, y, dbWidth, meterHeight, this.rmsLevels[channelIndex], dbMetrics)
      }
    }
  }

  private drawStereoVerticalBarMode(width: number, height: number): void {
    const ctx = this.ctx
    const [cr, cg, cb] = parseHexColor(this.options.lineColor)

    const sidePadding = clamp(width * 0.08, 4, 18)
    const channelGap = clamp(width * 0.08, 4, 16)
    const gapY = clamp(height * 0.03, 2, 8)
    const maxMeterWidth = Math.max(4, (width - channelGap) / 2)
    const availableMeterWidth = Math.max(8, width - sidePadding * 2 - channelGap)
    const meterWidth = Math.min(Math.max(6, availableMeterWidth / 2), maxMeterWidth)
    const totalMeterWidth = meterWidth * 2 + channelGap
    const meterLeft = Math.max(0, (width - totalMeterWidth) / 2)
    const labelMetrics = this.fitTextBand(['L', 'R'], meterWidth, height, 'channel')
    let dbMetrics = meterWidth >= MIN_VERTICAL_DB_METER_WIDTH_PX
      ? this.fitTextBand([this.getStableDbText()], meterWidth, height, 'db')
      : null
    const labelHeight = labelMetrics ? Math.ceil(labelMetrics.bandHeight) : 0
    let dbHeight = dbMetrics ? Math.ceil(dbMetrics.bandHeight) : 0
    const corrX = clamp(width * 0.06, 4, 20)
    const corrWidth = Math.max(1, width - corrX * 2)
    const corrHeight = Math.max(
      10,
      Math.ceil(this.fitTextBand(['-1', 'Ø', '+1'], Math.max(1, corrWidth / 3), height, 'correlation')?.bandHeight
        ?? (CORRELATION_LABEL_MIN_FONT_PX + TEXT_PADDING_Y_PX * 2))
    )
    const meterTop = labelHeight > 0 ? labelHeight + gapY : 0
    let meterHeight = height - meterTop - corrHeight - gapY - (dbHeight > 0 ? (dbHeight + gapY) : 0)
    if (dbMetrics && meterHeight < 24) {
      dbMetrics = null
      dbHeight = 0
      meterHeight = height - meterTop - corrHeight - gapY
    }
    meterHeight = Math.max(1, meterHeight)
    const dbY = meterTop + meterHeight + (dbMetrics ? gapY : 0)
    const corrY = meterTop + meterHeight + (dbMetrics ? gapY + dbHeight + gapY : gapY)

    const leftX = meterLeft
    const rightX = meterLeft + meterWidth + channelGap

    if (labelMetrics && labelHeight > 0) {
      this.drawMeterLabel(ctx, leftX, 0, meterWidth, labelHeight, 'L', labelMetrics)
    }
    this.drawVerticalMeterBar(ctx, leftX, meterTop, meterWidth, meterHeight, this.rmsLevels[0], this.peakLevels[0], cr, cg, cb)
    if (dbMetrics && dbHeight > 0) {
      this.drawCenteredDbLabel(ctx, leftX, dbY, meterWidth, dbHeight, this.rmsLevels[0], dbMetrics)
    }

    if (labelMetrics && labelHeight > 0) {
      this.drawMeterLabel(ctx, rightX, 0, meterWidth, labelHeight, 'R', labelMetrics)
    }
    this.drawVerticalMeterBar(ctx, rightX, meterTop, meterWidth, meterHeight, this.rmsLevels[1], this.peakLevels[1], cr, cg, cb)
    if (dbMetrics && dbHeight > 0) {
      this.drawCenteredDbLabel(ctx, rightX, dbY, meterWidth, dbHeight, this.rmsLevels[1], dbMetrics)
    }

    this.drawCorrelationBar(ctx, corrX, corrY, corrWidth, corrHeight, cr, cg, cb)
  }

  private drawMultichannelVerticalBarMode(width: number, height: number): void {
    const ctx = this.ctx
    const [cr, cg, cb] = parseHexColor(this.options.lineColor)
    const sidePadding = clamp(width * 0.05, 4, 14)
    const channelGap = clamp(width * 0.02, 2, 8)
    const gapY = clamp(height * 0.03, 2, 8)
    const totalGapWidth = channelGap * Math.max(0, this.activeChannelCount - 1)
    const availableMeterWidth = Math.max(8, width - sidePadding * 2 - totalGapWidth)
    const meterWidth = Math.max(4, availableMeterWidth / this.activeChannelCount)
    const totalMeterWidth = meterWidth * this.activeChannelCount + totalGapWidth
    const meterLeft = Math.max(0, (width - totalMeterWidth) / 2)
    const labelMetrics = this.fitTextBand(this.getChannelLabels(), meterWidth, height, 'channel')
    const labelHeight = labelMetrics ? Math.ceil(labelMetrics.bandHeight) : 0
    let dbMetrics = this.activeChannelCount === 1 && meterWidth >= MIN_VERTICAL_DB_METER_WIDTH_PX
      ? this.fitTextBand([this.getStableDbText()], meterWidth, height, 'db')
      : null
    let dbHeight = dbMetrics ? Math.ceil(dbMetrics.bandHeight) : 0
    const meterTop = labelHeight > 0 ? labelHeight + gapY : 0
    let meterHeight = height - meterTop - (dbHeight > 0 ? (dbHeight + gapY) : 0)
    if (dbMetrics && meterHeight < 24) {
      dbMetrics = null
      dbHeight = 0
      meterHeight = height - meterTop
    }
    meterHeight = Math.max(1, meterHeight)
    const dbY = meterTop + meterHeight + (dbMetrics ? gapY : 0)

    for (let channelIndex = 0; channelIndex < this.activeChannelCount; channelIndex++) {
      const x = meterLeft + (channelIndex * (meterWidth + channelGap))
      if (labelMetrics && labelHeight > 0) {
        this.drawMeterLabel(ctx, x, 0, meterWidth, labelHeight, this.getChannelLabel(channelIndex), labelMetrics)
      }
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
      if (dbMetrics && dbHeight > 0) {
        this.drawCenteredDbLabel(ctx, x, dbY, meterWidth, dbHeight, this.rmsLevels[channelIndex], dbMetrics)
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
    label: string,
    metrics: FittedTextMetrics
  ): void {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)'
    ctx.font = this.getMonoFont(metrics.fontSize)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, x + w / 2, y + h / 2)
  }

  private drawDbLabel(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, _w: number, h: number,
    db: number,
    metrics: FittedTextMetrics
  ): void {
    const text = this.getDbText(db)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)'
    ctx.font = this.getMonoFont(metrics.fontSize)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x + metrics.paddingX, y + h / 2)
  }

  private drawCenteredDbLabel(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    db: number,
    metrics: FittedTextMetrics,
    includeUnit = false
  ): void {
    const text = this.getDbText(db, includeUnit)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)'
    ctx.font = this.getMonoFont(metrics.fontSize)
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

    const labelMetrics = this.fitTextBand(['-1', 'Ø', '+1'], Math.max(1, w / 3), h, 'correlation')
    if (!labelMetrics) return

    ctx.font = this.getMonoFont(labelMetrics.fontSize)
    ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)'
    ctx.textAlign = 'left'
    ctx.fillText('-1', x + labelMetrics.paddingX, y + h / 2)
    ctx.textAlign = 'center'
    ctx.fillText('Ø', centerX, y + h / 2)
    ctx.textAlign = 'right'
    ctx.fillText('+1', x + w - labelMetrics.paddingX, y + h / 2)
  }

  private drawNeedleMode(width: number, height: number): void {
    const ctx = this.ctx
    const [cr, cg, cb] = parseHexColor(this.options.lineColor)
    const corrHeight = Math.max(
      10,
      Math.ceil(this.fitTextBand(['-1', 'Ø', '+1'], Math.max(1, width / 3), height, 'correlation')?.bandHeight
        ?? (CORRELATION_LABEL_MIN_FONT_PX + TEXT_PADDING_Y_PX * 2))
    )
    const gap = clamp(height * 0.03, 2, 8)
    const meterAreaHeight = height - corrHeight - gap
    const meterWidth = Math.max(1, (width - 4) / 2)
    const labelMetrics = this.fitTextBand(['L', 'R'], meterWidth, meterAreaHeight, 'channel')
    const dbMetrics = this.fitTextBand([this.getStableDbText(true)], meterWidth, meterAreaHeight, 'db')
    const barLeft = clamp(width * 0.06, 16, Math.max(16, width / 4)) + 4
    const barRight = width - clamp(width * 0.08, 36, Math.max(36, width / 3)) - 4
    const barWidth = Math.max(1, barRight - barLeft)
    const leftRms = this.getRmsLevel(0)
    const leftPeak = this.getPeakLevel(0)
    const rightRms = this.getRmsLevel(1)
    const rightPeak = this.getPeakLevel(1)

    this.drawNeedleMeter(ctx, 0, 0, meterWidth, meterAreaHeight, leftRms, leftPeak, 'L', cr, cg, cb, labelMetrics, dbMetrics)
    this.drawNeedleMeter(ctx, meterWidth + 4, 0, meterWidth, meterAreaHeight, rightRms, rightPeak, 'R', cr, cg, cb, labelMetrics, dbMetrics)
    this.drawCorrelationBar(ctx, barLeft, meterAreaHeight + gap, barWidth, corrHeight, cr, cg, cb)
  }

  private drawNeedleMeter(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    rmsDb: number, peakDb: number,
    label: string,
    cr: number, cg: number, cb: number,
    labelMetrics: FittedTextMetrics | null,
    dbMetrics: FittedTextMetrics | null
  ): void {
    const labelHeight = labelMetrics ? Math.ceil(labelMetrics.bandHeight) : 0
    const dbHeight = dbMetrics ? Math.ceil(dbMetrics.bandHeight) : 0
    const topPadding = labelHeight > 0 ? labelHeight + 4 : 4
    const bottomPadding = dbHeight > 0 ? dbHeight + 4 : 4
    const arcAreaTop = y + topPadding
    const arcAreaHeight = Math.max(1, h - topPadding - bottomPadding)
    const centerX = x + w / 2
    const arcRadius = Math.min(w * 0.42, arcAreaHeight * 0.65)
    const arcCenterY = arcAreaTop + arcAreaHeight * 0.78
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

    if (labelMetrics && labelHeight > 0) {
      this.drawMeterLabel(ctx, x, y, w, labelHeight, label, labelMetrics)
    }
    if (dbMetrics && dbHeight > 0) {
      this.drawCenteredDbLabel(ctx, x, y + h - dbHeight, w, dbHeight, rmsDb, dbMetrics, true)
    }
  }

  private drawFrame = (): void => {
    const { canvas, ctx, options } = this
    const width = canvas.width
    const height = canvas.height
    const dpr = window.devicePixelRatio || 1
    const cssWidth = width / dpr
    const cssHeight = height / dpr

    if (width <= 0 || height <= 0 || cssWidth <= 0 || cssHeight <= 0) {
      return
    }

    this.processAudio()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    if (options.mode === 'needle') {
      this.drawNeedleMode(cssWidth, cssHeight)
    } else {
      this.drawBarMode(cssWidth, cssHeight)
    }
    ctx.restore()
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
