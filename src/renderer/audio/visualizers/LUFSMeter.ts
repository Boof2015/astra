import { audioEngine } from '../AudioEngine'
import {
  lufsmeter as nativeLUFSMeter,
  type LUFSMeterNativeAnalyzer,
  type LUFSMeterNativeSnapshot,
} from '../native/index'
import type { LUFSMeterMode, LUFSMeterReadout } from '../../../types/lufsmeter'
import { resolveColorToRgb } from '../../utils/color'
import { getCanvasBackingPixelRatio } from '../../utils/canvasSizing'
import { defaultVisualizerSessionSource, type VisualizerSessionSource } from './dataSource'
import { FrameScheduler } from './frameScheduler'
import { VisualizerFrameLoop } from './visualizerFrameLoop'

export interface LUFSMeterDataSource extends VisualizerSessionSource {
  getPendingLUFSMeterSamples: () => Array<{ left: Float32Array; right: Float32Array }>
}

export interface LUFSMeterOptions {
  mode?: LUFSMeterMode
  readout?: LUFSMeterReadout
  backgroundColor?: string
  lineColor?: string
  trackColor?: string
  targetColor?: string
  scaleColor?: string
  labelColor?: string
  dataSource?: LUFSMeterDataSource
  frameScheduler?: FrameScheduler
  nativeAnalyzer?: LUFSMeterNativeAnalyzer | null
}

type ResolvedLUFSMeterOptions = Required<Omit<LUFSMeterOptions, 'dataSource' | 'frameScheduler' | 'nativeAnalyzer'>>

const defaultOptions: ResolvedLUFSMeterOptions = {
  mode: 'bar',
  readout: 'shortTerm',
  backgroundColor: 'transparent',
  lineColor: '#38bdf8',
  trackColor: 'rgba(56, 189, 248, 0.08)',
  targetColor: 'rgba(56, 189, 248, 0.25)',
  scaleColor: 'rgba(255, 255, 255, 0.35)',
  labelColor: 'rgba(255, 255, 255, 0.8)',
}

const defaultLUFSMeterDataSource: LUFSMeterDataSource = {
  getPendingLUFSMeterSamples: () => audioEngine.flushPendingLUFSMeterSamples(),
  ...defaultVisualizerSessionSource,
}

function colorWithAlpha(r: number, g: number, b: number, a: number): string {
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

function relativeLuminanceChannel(channel: number): number {
  const normalized = Math.max(0, Math.min(255, channel)) / 255
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4
}

function contrastRatio(luminanceA: number, luminanceB: number): number {
  const lighter = Math.max(luminanceA, luminanceB)
  const darker = Math.min(luminanceA, luminanceB)
  return (lighter + 0.05) / (darker + 0.05)
}

// ---- Constants ----

const METER_MIN_LUFS = -60
const COMPACT_METER_MIN_DB = -50
const COMPACT_METER_MAX_DB = 0
const TARGET_LUFS = -14
const METER_MIN_DB = -60
const MAX_METER_VIEWPORT_CSS_WIDTH = 240
const FULL_READOUT_WIDTH_SAMPLE = '-00.0LUFS'

const INITIAL_NATIVE_SNAPSHOT: LUFSMeterNativeSnapshot = {
  momentaryLUFS: METER_MIN_LUFS,
  shortTermLUFS: METER_MIN_LUFS,
  integratedLUFS: METER_MIN_LUFS,
  vuLDb: METER_MIN_DB,
  vuRDb: METER_MIN_DB,
  barLDb: METER_MIN_DB,
  barRDb: METER_MIN_DB,
  peakLDb: METER_MIN_DB,
  peakRDb: METER_MIN_DB,
  correlation: 0,
}

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function normalizeNativeSnapshot(snapshot: LUFSMeterNativeSnapshot | null): LUFSMeterNativeSnapshot {
  if (!snapshot) {
    return { ...INITIAL_NATIVE_SNAPSHOT }
  }

  return {
    momentaryLUFS: finiteNumber(snapshot.momentaryLUFS, METER_MIN_LUFS),
    shortTermLUFS: finiteNumber(snapshot.shortTermLUFS, METER_MIN_LUFS),
    integratedLUFS: finiteNumber(snapshot.integratedLUFS, METER_MIN_LUFS),
    vuLDb: finiteNumber(snapshot.vuLDb, METER_MIN_DB),
    vuRDb: finiteNumber(snapshot.vuRDb, METER_MIN_DB),
    barLDb: finiteNumber(snapshot.barLDb, METER_MIN_DB),
    barRDb: finiteNumber(snapshot.barRDb, METER_MIN_DB),
    peakLDb: finiteNumber(snapshot.peakLDb, METER_MIN_DB),
    peakRDb: finiteNumber(snapshot.peakRDb, METER_MIN_DB),
    correlation: finiteNumber(snapshot.correlation, 0),
  }
}

// ---- Loudness meter class ----

export class LUFSMeter {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private options: ResolvedLUFSMeterOptions
  private dataSource: LUFSMeterDataSource
  private nativeAnalyzer: LUFSMeterNativeAnalyzer | null
  private frameLoop: VisualizerFrameLoop
  private currentSampleRate = 0
  private snapshot: LUFSMeterNativeSnapshot = { ...INITIAL_NATIVE_SNAPSHOT }
  private pushScratchL = new Float32Array(0)
  private pushScratchR = new Float32Array(0)
  private unsubscribeSessionChange: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement, options: LUFSMeterOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx

    const { dataSource, frameScheduler, nativeAnalyzer, ...optionOverrides } = options
    this.options = { ...defaultOptions, ...optionOverrides }
    this.dataSource = dataSource ?? defaultLUFSMeterDataSource
    this.nativeAnalyzer = nativeAnalyzer === undefined ? nativeLUFSMeter : nativeAnalyzer
    this.frameLoop = new VisualizerFrameLoop({
      frameScheduler,
      shouldRun: () => this.dataSource.isPlaying(),
      onFrame: this.drawFrame,
    })

    this.resetMeters()
    this.subscribeToSessionChanges()
  }

  private subscribeToSessionChanges(): void {
    if (this.unsubscribeSessionChange) {
      this.unsubscribeSessionChange()
    }
    this.unsubscribeSessionChange = this.dataSource.subscribeToSessionChanges(() => {
      this.resetMeters()
    })
  }

  private resetMeters(): void {
    this.currentSampleRate = Math.max(1, this.dataSource.getSampleRate())
    this.snapshot = { ...INITIAL_NATIVE_SNAPSHOT }
    if (this.isNativeAnalyzerReady()) {
      this.nativeAnalyzer?.setSampleRate(this.currentSampleRate)
      this.nativeAnalyzer?.reset()
    }
    this.invalidate()
  }

  setOptions(options: Partial<LUFSMeterOptions>): void {
    const { dataSource, frameScheduler: _frameScheduler, nativeAnalyzer, ...optionUpdates } = options
    this.options = { ...this.options, ...optionUpdates }
    let didReset = false
    if (nativeAnalyzer !== undefined && nativeAnalyzer !== this.nativeAnalyzer) {
      this.nativeAnalyzer = nativeAnalyzer
      this.resetMeters()
      didReset = true
    }
    if (dataSource && dataSource !== this.dataSource) {
      this.dataSource = dataSource
      this.subscribeToSessionChanges()
      this.resetMeters()
      didReset = true
    }
    if (!didReset) {
      this.invalidate()
    }
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
    // Canvas resize handled externally
    this.invalidate()
  }

  private processAudio(): void {
    const chunks = this.dataSource.getPendingLUFSMeterSamples()
    const sampleRate = Math.max(1, this.dataSource.getSampleRate())

    if (Math.abs(sampleRate - this.currentSampleRate) > 100) {
      this.resetMeters()
    }

    if (!this.isNativeAnalyzerReady() || !this.dataSource.isPlaying()) {
      this.nativeAnalyzer?.reset()
      this.snapshot = { ...INITIAL_NATIVE_SNAPSHOT }
      return
    }

    if (chunks.length > 0) {
      const batch = this.concatStereoChunks(chunks)
      if (batch.left.length > 0 && batch.right.length > 0) {
        this.nativeAnalyzer?.pushSamples(batch.left, batch.right)
      }
    }

    this.snapshot = normalizeNativeSnapshot(this.nativeAnalyzer?.getSnapshot() ?? null)
  }

  private isNativeAnalyzerReady(): boolean {
    if (!this.nativeAnalyzer) {
      return false
    }
    return this.nativeAnalyzer.isAvailable?.() ?? true
  }

  private concatStereoChunks(chunks: Array<{ left: Float32Array; right: Float32Array }>): { left: Float32Array; right: Float32Array } {
    if (chunks.length === 1) {
      const chunk = chunks[0]
      const length = Math.min(chunk.left.length, chunk.right.length)
      return {
        left: chunk.left.length === length ? chunk.left : chunk.left.subarray(0, length),
        right: chunk.right.length === length ? chunk.right : chunk.right.subarray(0, length),
      }
    }

    let totalLength = 0
    for (const chunk of chunks) {
      totalLength += Math.min(chunk.left.length, chunk.right.length)
    }
    if (totalLength === 0) {
      return { left: new Float32Array(0), right: new Float32Array(0) }
    }

    if (this.pushScratchL.length < totalLength) {
      this.pushScratchL = new Float32Array(totalLength)
      this.pushScratchR = new Float32Array(totalLength)
    }

    const left = this.pushScratchL.subarray(0, totalLength)
    const right = this.pushScratchR.subarray(0, totalLength)
    let offset = 0
    for (const chunk of chunks) {
      const length = Math.min(chunk.left.length, chunk.right.length)
      if (length <= 0) {
        continue
      }
      left.set(chunk.left.subarray(0, length), offset)
      right.set(chunk.right.subarray(0, length), offset)
      offset += length
    }

    return { left, right }
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
    if (options.backgroundColor !== 'transparent') {
      ctx.fillStyle = options.backgroundColor
      ctx.fillRect(0, 0, width, height)
    }

    this.drawBars(width, height)
  }

  private selectedLufs(): number {
    switch (this.options.readout) {
      case 'momentary':
        return this.snapshot.momentaryLUFS
      case 'shortTerm':
        return this.snapshot.shortTermLUFS
      case 'integrated':
      default:
        return this.snapshot.integratedLUFS
    }
  }

  private compactDbToNormalized(db: number): number {
    const clamped = Math.max(COMPACT_METER_MIN_DB, Math.min(COMPACT_METER_MAX_DB, db))
    return (clamped - COMPACT_METER_MIN_DB) / (COMPACT_METER_MAX_DB - COMPACT_METER_MIN_DB)
  }

  private contrastForLevelColor(): string {
    const { r, g, b } = resolveColorToRgb(this.options.lineColor)
    const luminance = 0.2126 * relativeLuminanceChannel(r)
      + 0.7152 * relativeLuminanceChannel(g)
      + 0.0722 * relativeLuminanceChannel(b)
    return contrastRatio(luminance, 0) >= contrastRatio(luminance, 1)
      ? 'rgba(0, 0, 0, 0.9)'
      : 'rgba(255, 255, 255, 0.94)'
  }

  private resolveReadoutTextLayout(
    candidates: string[],
    maxWidth: number,
    maxFontSize: number,
    minFontSize: number,
  ): { text: string; fontSize: number } {
    const ctx = this.ctx
    for (const text of candidates) {
      ctx.font = `700 ${maxFontSize}px "JetBrains Mono", "SF Mono", monospace`
      const measuredWidth = ctx.measureText(text).width
      if (measuredWidth <= maxWidth) {
        return { text, fontSize: maxFontSize }
      }

      const scaledFontSize = Math.floor(maxFontSize * (maxWidth / Math.max(1, measuredWidth)))
      if (scaledFontSize >= minFontSize) {
        return { text, fontSize: scaledFontSize }
      }
    }

    return {
      text: candidates[candidates.length - 1] ?? '',
      fontSize: minFontSize,
    }
  }

  private drawFastPeakBar(
    x: number,
    y: number,
    width: number,
    height: number,
    levelDb: number,
    peakDb: number,
    tint: { r: number; g: number; b: number },
    dpr: number,
  ): void {
    const ctx = this.ctx
    const barBottom = y + height
    const levelHeight = Math.round(this.compactDbToNormalized(levelDb) * height)

    ctx.fillStyle = this.options.trackColor
    ctx.fillRect(x, y, width, height)

    if (levelHeight > 0) {
      ctx.fillStyle = colorWithAlpha(tint.r, tint.g, tint.b, 0.88)
      ctx.fillRect(x, barBottom - levelHeight, width, levelHeight)
    }

    const peakNorm = this.compactDbToNormalized(peakDb)
    if (peakNorm > 0.001) {
      const peakY = Math.round(barBottom - peakNorm * height)
      ctx.fillStyle = `rgb(${tint.r}, ${tint.g}, ${tint.b})`
      ctx.fillRect(x, peakY, width, Math.max(1, Math.round(2 * dpr)))
    }
  }

  private drawBars(width: number, height: number): void {
    const ctx = this.ctx
    const tint = resolveColorToRgb(this.options.lineColor)
    const dpr = getCanvasBackingPixelRatio(this.canvas)
    const cssWidth = width / dpr
    const cssHeight = height / dpr

    const paddingX = Math.round(Math.max(4, Math.floor(cssWidth * 0.012)) * dpr)
    const paddingY = Math.round(Math.max(4, Math.floor(cssHeight * 0.025)) * dpr)
    const meterTop = paddingY
    const meterBottom = height - paddingY
    const meterHeight = Math.max(1, meterBottom - meterTop)
    const availableViewportWidth = Math.max(1, width - paddingX * 2)
    const viewportWidth = Math.max(1, Math.min(
      availableViewportWidth,
      Math.round(MAX_METER_VIEWPORT_CSS_WIDTH * dpr),
    ))
    const viewportX = Math.round((width - viewportWidth) / 2)
    const viewportCssWidth = viewportWidth / dpr
    const scaleWidth = Math.round(Math.max(22, Math.min(36, Math.floor(viewportCssWidth * 0.14))) * dpr)
    const barGap = Math.round(Math.max(3, Math.floor(viewportCssWidth * 0.012)) * dpr)
    const lufsBarGap = Math.round(Math.max(5, Math.floor(viewportCssWidth * 0.018)) * dpr)
    const tagGap = Math.round(Math.max(6, Math.floor(viewportCssWidth * 0.02)) * dpr)
    const minimumBarWidth = Math.round(6 * dpr)
    const minimumLufsBarWidth = minimumBarWidth * 2

    const selectedLufs = this.selectedLufs()
    const displayValue = selectedLufs <= METER_MIN_LUFS + 1
      ? '-∞'
      : selectedLufs.toFixed(1)
    const tagHeightCss = Math.max(1, Math.min(
      meterHeight / dpr,
      Math.max(16, Math.min(22, Math.floor(cssHeight * 0.1))),
    ))
    const tagHeight = Math.max(1, Math.round(tagHeightCss * dpr))
    const tagPaddingCss = Math.max(4, Math.min(7, Math.floor(tagHeightCss * 0.4)))
    const tagPadding = Math.round(tagPaddingCss * dpr)
    const readoutFontSizeCss = Math.max(9, Math.min(13, Math.floor(tagHeightCss * 0.62)))
    const readoutFontSize = Math.round(readoutFontSizeCss * dpr)
    const minimumReadoutFontSize = Math.round(Math.max(7, Math.floor(readoutFontSizeCss * 0.7)) * dpr)
    ctx.font = `700 ${readoutFontSize}px "JetBrains Mono", "SF Mono", monospace`
    const fullReadoutWidth = Math.ceil(ctx.measureText(FULL_READOUT_WIDTH_SAMPLE).width) + tagPadding * 2
    const fixedLayoutWidth = scaleWidth + barGap + lufsBarGap + tagGap
    const minimumBarsWidth = minimumBarWidth * 2 + minimumLufsBarWidth
    const maximumReadoutWidth = Math.max(1, viewportWidth - fixedLayoutWidth - minimumBarsWidth)
    const useFullReadout = fullReadoutWidth <= maximumReadoutWidth
    const reservedReadoutWidth = Math.max(1, Math.min(
      maximumReadoutWidth,
      fullReadoutWidth,
    ))
    const readoutCandidates = useFullReadout
      ? [`${displayValue}LUFS`, displayValue]
      : [displayValue]
    const readoutLayout = this.resolveReadoutTextLayout(
      readoutCandidates,
      Math.max(1, reservedReadoutWidth - tagPadding * 2),
      readoutFontSize,
      minimumReadoutFontSize,
    )

    const barsWidth = Math.max(4, viewportWidth - fixedLayoutWidth - reservedReadoutWidth)
    const barWidth = Math.max(1, Math.floor(barsWidth / 4))
    const lufsBarWidth = Math.max(2, barsWidth - barWidth * 2)
    const leftBarX = viewportX + scaleWidth
    const rightBarX = leftBarX + barWidth + barGap
    const lufsBarX = rightBarX + barWidth + lufsBarGap
    const tagAreaX = lufsBarX + lufsBarWidth + tagGap

    this.drawFastPeakBar(
      leftBarX,
      meterTop,
      barWidth,
      meterHeight,
      this.snapshot.barLDb,
      this.snapshot.peakLDb,
      tint,
      dpr,
    )
    this.drawFastPeakBar(
      rightBarX,
      meterTop,
      barWidth,
      meterHeight,
      this.snapshot.barRDb,
      this.snapshot.peakRDb,
      tint,
      dpr,
    )

    const loudnessNorm = this.compactDbToNormalized(selectedLufs)
    const loudnessY = Math.round(meterBottom - loudnessNorm * meterHeight)
    const lufsBarHeight = Math.round(loudnessNorm * meterHeight)

    ctx.fillStyle = this.options.trackColor
    ctx.fillRect(lufsBarX, meterTop, lufsBarWidth, meterHeight)
    if (lufsBarHeight > 0) {
      ctx.fillStyle = this.options.lineColor
      ctx.fillRect(lufsBarX, meterBottom - lufsBarHeight, lufsBarWidth, lufsBarHeight)
    }

    const targetY = Math.round(meterBottom - this.compactDbToNormalized(TARGET_LUFS) * meterHeight)
    ctx.fillStyle = this.options.targetColor
    ctx.fillRect(leftBarX, targetY, Math.max(1, lufsBarX + lufsBarWidth - leftBarX), Math.max(1, Math.round(dpr)))

    const tickValues = [0, -6, -12, -24, -36, -50]
    const tickMarkWidth = Math.round(6 * dpr)
    const tickFontSizeCss = Math.max(8, Math.min(13, Math.floor(cssHeight * 0.055)))
    const tickFontSize = Math.round(tickFontSizeCss * dpr)
    ctx.font = `600 ${tickFontSize}px "JetBrains Mono", "SF Mono", monospace`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = this.options.scaleColor
    for (const tick of tickValues) {
      const y = Math.round(meterBottom - this.compactDbToNormalized(tick) * meterHeight)
      const labelY = Math.max(
        meterTop + tickFontSize / 2,
        Math.min(meterBottom - tickFontSize / 2, y),
      )
      ctx.fillText(`${Math.abs(tick)}`, viewportX + scaleWidth - Math.round(7 * dpr), labelY)
      ctx.fillRect(viewportX + scaleWidth - tickMarkWidth, y, tickMarkWidth, Math.max(1, Math.round(dpr)))
    }

    ctx.font = `700 ${readoutLayout.fontSize}px "JetBrains Mono", "SF Mono", monospace`
    const measuredText = ctx.measureText(readoutLayout.text).width
    const tagWidth = Math.max(1, Math.min(reservedReadoutWidth, Math.ceil(measuredText) + tagPadding * 2))
    const tagX = Math.round(tagAreaX + (reservedReadoutWidth - tagWidth) / 2)
    const tagY = Math.round(Math.max(meterTop, Math.min(meterBottom - tagHeight, loudnessY - tagHeight / 2)))

    ctx.fillStyle = this.options.lineColor
    ctx.fillRect(tagX, tagY, tagWidth, tagHeight)

    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = this.contrastForLevelColor()
    ctx.fillText(readoutLayout.text, tagX + tagPadding, tagY + tagHeight / 2)
  }

  dispose(): void {
    this.stop()
    this.frameLoop.dispose()
    if (this.unsubscribeSessionChange) {
      this.unsubscribeSessionChange()
      this.unsubscribeSessionChange = null
    }
    if (this.isNativeAnalyzerReady()) {
      this.nativeAnalyzer?.reset()
    }
  }
}
