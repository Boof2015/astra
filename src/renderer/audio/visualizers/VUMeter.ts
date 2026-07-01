import { audioEngine } from '../AudioEngine'
import {
  vumeter as nativeVUMeter,
  type VUMeterNativeAnalyzer,
  type VUMeterNativeSnapshot,
} from '../native/index'
import { resolveColorToRgb } from '../../utils/color'
import { defaultVisualizerSessionSource, type VisualizerSessionSource } from './dataSource'
import { FrameScheduler } from './frameScheduler'
import { VisualizerFrameLoop } from './visualizerFrameLoop'
import {
  VUMeterBallistics,
  VU_METER_MAX_DB,
  VU_METER_MIN_DB,
  type VUMeterSnapshot,
} from './vuMeterBallistics'
import {
  DEFAULT_VU_METER_NEEDLE_CHANNELS,
  DEFAULT_VU_METER_ORIENTATION,
  DEFAULT_VU_REFERENCE_DBFS,
  type VUMeterNeedleChannels,
  type VUMeterMode,
  type VUMeterOrientation,
} from '../../../types/vumeter'

export interface VUMeterDataSource extends VisualizerSessionSource {
  getPendingVUMeterSamples: () => Array<{ left: Float32Array; right: Float32Array }>
}

export interface VUMeterOptions {
  mode?: VUMeterMode
  orientation?: VUMeterOrientation
  backgroundColor?: string
  lineColor?: string
  trackColor?: string
  peakColor?: string
  clipColor?: string
  scaleColor?: string
  labelColor?: string
  needleLeftColor?: string
  needleRightColor?: string
  needleCombinedColor?: string
  needleChannels?: VUMeterNeedleChannels
  referenceDb?: number
  dataSource?: VUMeterDataSource
  frameScheduler?: FrameScheduler
  nativeAnalyzer?: VUMeterNativeAnalyzer | null
}

type ResolvedVUMeterOptions = Required<Omit<VUMeterOptions, 'dataSource' | 'frameScheduler' | 'nativeAnalyzer'>>

const defaultOptions: ResolvedVUMeterOptions = {
  mode: 'bar',
  orientation: DEFAULT_VU_METER_ORIENTATION,
  backgroundColor: 'transparent',
  lineColor: '#38bdf8',
  trackColor: 'rgba(56, 189, 248, 0.08)',
  peakColor: 'rgb(255, 127, 0)',
  clipColor: 'rgba(255, 120, 80, 0.9)',
  scaleColor: 'rgba(255, 255, 255, 0.12)',
  labelColor: 'rgba(255, 255, 255, 0.5)',
  needleLeftColor: '#c7dfff',
  needleRightColor: '#ff477e',
  needleCombinedColor: '#f4f8ff',
  needleChannels: DEFAULT_VU_METER_NEEDLE_CHANNELS,
  referenceDb: DEFAULT_VU_REFERENCE_DBFS,
}

const defaultVUMeterDataSource: VUMeterDataSource = {
  // Astra's engine yields multichannel chunks; the ported VU meter is stereo (L/R).
  getPendingVUMeterSamples: () => audioEngine.flushPendingVUMeterSamples().map((chunk) => {
    const left = chunk.channels[0] ?? new Float32Array(0)
    return { left, right: chunk.channels[1] ?? left }
  }),
  ...defaultVisualizerSessionSource,
}

const INITIAL_NATIVE_SNAPSHOT: VUMeterNativeSnapshot = {
  vuLDb: VU_METER_MIN_DB,
  vuRDb: VU_METER_MIN_DB,
  barLDb: VU_METER_MIN_DB,
  barRDb: VU_METER_MIN_DB,
  peakLDb: VU_METER_MIN_DB,
  peakRDb: VU_METER_MIN_DB,
  correlation: 0,
}

const NEEDLE_VISUAL_SMOOTHING_SECONDS = 0.065
const NEEDLE_PEAK_DECAY_DB_PER_SECOND = 12
const NEEDLE_PIVOT_FRACTION = 0.91
const NEEDLE_STEREO_GAP_FRACTION = 0.14
export const VU_NEEDLE_FACE_WIDTH_CSS_PX = 560
export const VU_NEEDLE_FACE_HEIGHT_CSS_PX = 360

export interface VUNeedleFaceLayout {
  x: number
  y: number
  width: number
  height: number
  scale: number
}

function colorWithAlpha(r: number, g: number, b: number, a: number): string {
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

function alphaColor(color: string, alpha: number): string {
  const { r, g, b } = resolveColorToRgb(color)
  return colorWithAlpha(r, g, b, alpha)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function normalizeNativeSnapshot(snapshot: VUMeterNativeSnapshot | null): VUMeterNativeSnapshot {
  if (!snapshot) {
    return { ...INITIAL_NATIVE_SNAPSHOT }
  }

  return {
    vuLDb: finiteNumber(snapshot.vuLDb, VU_METER_MIN_DB),
    vuRDb: finiteNumber(snapshot.vuRDb, VU_METER_MIN_DB),
    barLDb: finiteNumber(snapshot.barLDb, VU_METER_MIN_DB),
    barRDb: finiteNumber(snapshot.barRDb, VU_METER_MIN_DB),
    peakLDb: finiteNumber(snapshot.peakLDb, VU_METER_MIN_DB),
    peakRDb: finiteNumber(snapshot.peakRDb, VU_METER_MIN_DB),
    correlation: finiteNumber(snapshot.correlation, 0),
  }
}

function normalizeDevicePixelRatio(devicePixelRatio: number): number {
  return Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1
}

function getCanvasDevicePixelRatio(): number {
  return normalizeDevicePixelRatio(
    typeof window === 'undefined' ? 1 : window.devicePixelRatio,
  )
}

export function resolveVUNeedleFaceLayout(
  canvasWidth: number,
  canvasHeight: number,
  devicePixelRatio = 1,
): VUNeedleFaceLayout {
  const dpr = normalizeDevicePixelRatio(devicePixelRatio)
  const targetWidth = VU_NEEDLE_FACE_WIDTH_CSS_PX * dpr
  const targetHeight = VU_NEEDLE_FACE_HEIGHT_CSS_PX * dpr
  const safeWidth = Math.max(0, Number.isFinite(canvasWidth) ? canvasWidth : 0)
  const safeHeight = Math.max(0, Number.isFinite(canvasHeight) ? canvasHeight : 0)
  const scale = Math.min(1, safeWidth / targetWidth, safeHeight / targetHeight)
  const width = targetWidth * scale
  const height = targetHeight * scale

  return {
    x: Math.max(0, (safeWidth - width) / 2),
    y: Math.max(0, safeHeight - height),
    width,
    height,
    scale,
  }
}

export const CLASSIC_VU_MIN = -20
export const CLASSIC_VU_MAX = 3
export const CLASSIC_VU_LABELS: ReadonlyArray<{ vu: number; label: string }> = [
  { vu: -20, label: '20' },
  { vu: -10, label: '10' },
  { vu: -7, label: '7' },
  { vu: -5, label: '5' },
  { vu: -4, label: '4' },
  { vu: -3, label: '3' },
  { vu: -2, label: '2' },
  { vu: -1, label: '1' },
  { vu: 0, label: '0' },
  { vu: 1, label: '+1' },
  { vu: 2, label: '+2' },
  { vu: 3, label: '+3' },
]

const CLASSIC_VU_ANCHORS: ReadonlyArray<{ vu: number; position: number }> = [
  { vu: -20, position: 0 },
  { vu: -10, position: 0.24 },
  { vu: -7, position: 0.36 },
  { vu: -5, position: 0.46 },
  { vu: -4, position: 0.53 },
  { vu: -3, position: 0.60 },
  { vu: -2, position: 0.67 },
  { vu: -1, position: 0.74 },
  { vu: 0, position: 0.81 },
  { vu: 1, position: 0.88 },
  { vu: 2, position: 0.94 },
  { vu: 3, position: 1 },
]

export interface VUNeedleReading {
  id: 'left' | 'right' | 'combined'
  db: number
  peakDb: number
  vu: number
  peakVu: number
}

export function dbfsToClassicVu(db: number, referenceDb: number = DEFAULT_VU_REFERENCE_DBFS): number {
  if (!Number.isFinite(db)) {
    return CLASSIC_VU_MIN
  }
  return clamp(db - referenceDb, CLASSIC_VU_MIN, CLASSIC_VU_MAX)
}

export function classicVuToNormalized(vu: number): number {
  const clampedVu = clamp(
    Number.isFinite(vu) ? vu : CLASSIC_VU_MIN,
    CLASSIC_VU_MIN,
    CLASSIC_VU_MAX,
  )

  for (let index = 1; index < CLASSIC_VU_ANCHORS.length; index += 1) {
    const previous = CLASSIC_VU_ANCHORS[index - 1]
    const next = CLASSIC_VU_ANCHORS[index]
    if (!previous || !next || clampedVu > next.vu) continue

    const span = next.vu - previous.vu
    const progress = span > 0 ? (clampedVu - previous.vu) / span : 0
    return previous.position + progress * (next.position - previous.position)
  }

  return 1
}

export function stereoRmsDbAverage(leftDb: number, rightDb: number): number {
  const leftPower = 10 ** (clamp(leftDb, VU_METER_MIN_DB, VU_METER_MAX_DB) / 10)
  const rightPower = 10 ** (clamp(rightDb, VU_METER_MIN_DB, VU_METER_MAX_DB) / 10)
  const averagePower = (leftPower + rightPower) / 2
  const db = 10 * Math.log10(Math.max(averagePower, 1e-12))
  return clamp(db, VU_METER_MIN_DB, VU_METER_MAX_DB)
}

export function resolveVUNeedleReadings({
  leftDb,
  rightDb,
  leftPeakDb,
  rightPeakDb,
  needleChannels,
  referenceDb = DEFAULT_VU_REFERENCE_DBFS,
}: {
  leftDb: number
  rightDb: number
  leftPeakDb: number
  rightPeakDb: number
  needleChannels: VUMeterNeedleChannels
  referenceDb?: number
}): VUNeedleReading[] {
  if (needleChannels === 'combined') {
    const db = stereoRmsDbAverage(leftDb, rightDb)
    const peakDb = Math.max(leftPeakDb, rightPeakDb)
    return [{
      id: 'combined',
      db,
      peakDb,
      vu: dbfsToClassicVu(db, referenceDb),
      peakVu: dbfsToClassicVu(peakDb, referenceDb),
    }]
  }

  return [
    {
      id: 'left',
      db: leftDb,
      peakDb: leftPeakDb,
      vu: dbfsToClassicVu(leftDb, referenceDb),
      peakVu: dbfsToClassicVu(leftPeakDb, referenceDb),
    },
    {
      id: 'right',
      db: rightDb,
      peakDb: rightPeakDb,
      vu: dbfsToClassicVu(rightDb, referenceDb),
      peakVu: dbfsToClassicVu(rightPeakDb, referenceDb),
    },
  ]
}

// ---- VU Meter class ----

export class VUMeter {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private options: ResolvedVUMeterOptions
  private dataSource: VUMeterDataSource
  private nativeAnalyzer: VUMeterNativeAnalyzer | null
  private frameLoop: VisualizerFrameLoop
  private meterBallistics: VUMeterBallistics
  private currentSampleRate = 0
  private pushScratchL = new Float32Array(0)
  private pushScratchR = new Float32Array(0)
  private unsubscribeSessionChange: (() => void) | null = null

  // Meter state
  private vuL = VU_METER_MIN_DB
  private vuR = VU_METER_MIN_DB
  private peakL = VU_METER_MIN_DB
  private peakR = VU_METER_MIN_DB
  private correlation = 0
  private needleDisplayL = VU_METER_MIN_DB
  private needleDisplayR = VU_METER_MIN_DB
  private needlePeakL = VU_METER_MIN_DB
  private needlePeakR = VU_METER_MIN_DB
  private lastNeedleVisualUpdateMs: number | null = null

  constructor(canvas: HTMLCanvasElement, options: VUMeterOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx

    const { dataSource, frameScheduler, nativeAnalyzer, ...optionOverrides } = options
    this.options = { ...defaultOptions, ...optionOverrides }
    this.dataSource = dataSource ?? defaultVUMeterDataSource
    this.nativeAnalyzer = nativeAnalyzer === undefined ? nativeVUMeter : nativeAnalyzer
    this.meterBallistics = new VUMeterBallistics(this.dataSource.getSampleRate())
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
    this.meterBallistics.reinitialize(this.currentSampleRate)
    if (this.isNativeAnalyzerReady()) {
      this.nativeAnalyzer?.setSampleRate(this.currentSampleRate)
      this.nativeAnalyzer?.reset()
    }
    this.applySnapshot(this.meterBallistics.getSnapshot())
    this.resetNeedleVisuals()
    this.invalidate()
  }

  setOptions(options: Partial<VUMeterOptions>): void {
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

  private applySnapshot(snapshot: VUMeterSnapshot): void {
    this.vuL = snapshot.vuLDb
    this.vuR = snapshot.vuRDb
    this.peakL = snapshot.peakLDb
    this.peakR = snapshot.peakRDb
    this.correlation = snapshot.correlation
  }

  private resetNeedleVisuals(): void {
    this.needleDisplayL = this.vuL
    this.needleDisplayR = this.vuR
    this.needlePeakL = this.vuL
    this.needlePeakR = this.vuR
    this.lastNeedleVisualUpdateMs = null
  }

  private updateNeedleVisuals(nowMs: number): void {
    if (!Number.isFinite(nowMs)) {
      this.needleDisplayL = this.vuL
      this.needleDisplayR = this.vuR
      this.needlePeakL = this.vuL
      this.needlePeakR = this.vuR
      this.lastNeedleVisualUpdateMs = null
      return
    }

    if (this.lastNeedleVisualUpdateMs === null) {
      this.needleDisplayL = this.vuL
      this.needleDisplayR = this.vuR
      this.needlePeakL = this.vuL
      this.needlePeakR = this.vuR
      this.lastNeedleVisualUpdateMs = nowMs
      return
    }

    const elapsedSeconds = clamp((nowMs - this.lastNeedleVisualUpdateMs) / 1000, 0, 0.1)
    this.lastNeedleVisualUpdateMs = nowMs
    const amount = 1 - Math.exp(-elapsedSeconds / NEEDLE_VISUAL_SMOOTHING_SECONDS)
    this.needleDisplayL += (this.vuL - this.needleDisplayL) * amount
    this.needleDisplayR += (this.vuR - this.needleDisplayR) * amount
    this.needlePeakL = this.updateNeedlePeakVisual(this.needlePeakL, this.needleDisplayL, elapsedSeconds)
    this.needlePeakR = this.updateNeedlePeakVisual(this.needlePeakR, this.needleDisplayR, elapsedSeconds)
  }

  private updateNeedlePeakVisual(currentPeakDb: number, currentNeedleDb: number, elapsedSeconds: number): number {
    if (currentNeedleDb >= currentPeakDb) {
      return currentNeedleDb
    }

    return Math.max(
      currentNeedleDb,
      currentPeakDb - elapsedSeconds * NEEDLE_PEAK_DECAY_DB_PER_SECOND,
    )
  }

  private processAudio(nowMs = performance.now()): void {
    const sampleRate = Math.max(1, this.dataSource.getSampleRate())
    if (
      Math.abs(sampleRate - this.currentSampleRate) > 100
      || Math.abs(sampleRate - this.meterBallistics.getSampleRate()) > 100
    ) {
      this.resetMeters()
    }

    const chunks = this.dataSource.getPendingVUMeterSamples()
    if (!this.dataSource.isPlaying()) {
      const snapshot = this.isNativeAnalyzerReady()
        ? normalizeNativeSnapshot(this.nativeAnalyzer?.getSnapshot() ?? null)
        : this.meterBallistics.getSnapshot()
      this.applySnapshot(snapshot)
      return
    }

    if (this.isNativeAnalyzerReady()) {
      if (chunks.length > 0) {
        const batch = this.concatStereoChunks(chunks)
        if (batch.left.length > 0 && batch.right.length > 0) {
          this.nativeAnalyzer?.pushSamples(batch.left, batch.right)
        }
      }
      this.applySnapshot(normalizeNativeSnapshot(this.nativeAnalyzer?.getSnapshot() ?? null))
      return
    }

    this.applySnapshot(this.meterBallistics.process(chunks, nowMs))
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

  private dbToNormalized(db: number): number {
    // Map dBFS to bar position via the VU calibration so bars and the needle
    // share the same scale (0 VU sits at the hot threshold, +3 VU at full scale).
    return classicVuToNormalized(dbfsToClassicVu(db, this.options.referenceDb))
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
    const { r: cr, g: cg, b: cb } = resolveColorToRgb(this.options.lineColor)

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
    this.drawHorizontalMeterBar(ctx, barLeft, lY, barWidth, meterHeight, this.vuL, this.peakL, cr, cg, cb)
    this.drawMeterLabel(ctx, 0, lY, labelWidth, meterHeight, 'L')
    this.drawDbLabel(ctx, barRight + 4, lY, dbLabelWidth, meterHeight, this.vuL)

    // ---- R meter ----
    const rY = lY + meterHeight + gap
    this.drawHorizontalMeterBar(ctx, barLeft, rY, barWidth, meterHeight, this.vuR, this.peakR, cr, cg, cb)
    this.drawMeterLabel(ctx, 0, rY, labelWidth, meterHeight, 'R')
    this.drawDbLabel(ctx, barRight + 4, rY, dbLabelWidth, meterHeight, this.vuR)

    // ---- Correlation meter ----
    const corrY = rY + meterHeight + gap
    this.drawCorrelationBar(ctx, barLeft, corrY, barWidth, corrHeight, cr, cg, cb)
  }

  private drawVerticalBarMode(width: number, height: number): void {
    const ctx = this.ctx
    const { r: cr, g: cg, b: cb } = resolveColorToRgb(this.options.lineColor)

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
    this.drawVerticalMeterBar(ctx, lX, meterTop, meterWidth, meterHeight, this.vuL, this.peakL, cr, cg, cb)
    this.drawCenteredDbLabel(ctx, lX, dbY, meterWidth, dbHeight, this.vuL)

    this.drawMeterLabel(ctx, rX, 0, meterWidth, labelHeight, 'R')
    this.drawVerticalMeterBar(ctx, rX, meterTop, meterWidth, meterHeight, this.vuR, this.peakR, cr, cg, cb)
    this.drawCenteredDbLabel(ctx, rX, dbY, meterWidth, dbHeight, this.vuR)

    this.drawCorrelationBar(ctx, corrX, corrY, corrWidth, corrHeight, cr, cg, cb)
  }

  private drawHorizontalMeterBar(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    levelDb: number, peakDb: number,
    cr: number, cg: number, cb: number
  ): void {
    const levelNorm = this.dbToNormalized(levelDb)
    const peakNorm = this.dbToNormalized(peakDb)
    const levelWidth = levelNorm * w
    const hotThreshold = classicVuToNormalized(0) * w

    // Background track
    ctx.fillStyle = this.options.trackColor
    ctx.fillRect(x, y, w, h)

    // Main level bar
    if (levelWidth > 0) {
      const safeWidth = Math.min(levelWidth, hotThreshold)
      if (safeWidth > 0) {
        ctx.fillStyle = colorWithAlpha(cr, cg, cb, 0.82)
        ctx.fillRect(x, y, safeWidth, h)
      }
      if (levelWidth > hotThreshold) {
        // Hot zone: transition to warm/red
        const hotWidth = levelWidth - hotThreshold
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
      const peakInHot = dbfsToClassicVu(peakDb, this.options.referenceDb) > 0
      ctx.fillStyle = peakInHot
        ? this.options.clipColor
        : this.options.peakColor
      ctx.fillRect(peakX - 1, y, 2, h)
    }

    // Scale ticks (VU units)
    ctx.fillStyle = this.options.scaleColor
    const tickVus = [-20, -10, -5, -3, -1, 0, 1, 2, 3]
    for (const vu of tickVus) {
      const tickX = x + classicVuToNormalized(vu) * w
      ctx.fillRect(tickX, y + h - 3, 1, 3)
    }
  }

  private drawVerticalMeterBar(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    levelDb: number, peakDb: number,
    cr: number, cg: number, cb: number
  ): void {
    const levelNorm = this.dbToNormalized(levelDb)
    const peakNorm = this.dbToNormalized(peakDb)
    const levelHeight = levelNorm * h
    const hotThreshold = classicVuToNormalized(0) * h

    ctx.fillStyle = this.options.trackColor
    ctx.fillRect(x, y, w, h)

    if (levelHeight > 0) {
      const safeHeight = Math.min(levelHeight, hotThreshold)
      if (safeHeight > 0) {
        ctx.fillStyle = colorWithAlpha(cr, cg, cb, 0.82)
        ctx.fillRect(x, y + h - safeHeight, w, safeHeight)
      }
      if (levelHeight > hotThreshold) {
        const hotHeight = levelHeight - hotThreshold
        const hotProgress = Math.min(1, hotHeight / Math.max(1, h - hotThreshold))
        const hotR = Math.round(cr + (255 - cr) * hotProgress * 0.7)
        const hotG = Math.round(cg * (1 - hotProgress * 0.6))
        const hotB = Math.round(cb * (1 - hotProgress * 0.7))
        ctx.fillStyle = colorWithAlpha(hotR, hotG, hotB, 0.82)
        ctx.fillRect(x, y + h - levelHeight, w, hotHeight)
      }
    }

    if (peakNorm > 0.001) {
      const peakY = y + h - peakNorm * h
      const peakInHot = dbfsToClassicVu(peakDb, this.options.referenceDb) > 0
      ctx.fillStyle = peakInHot
        ? this.options.clipColor
        : this.options.peakColor
      ctx.fillRect(x, peakY - 1, w, 2)
    }

    ctx.fillStyle = alphaColor(this.options.scaleColor, 0.84)
    const tickVus = [-20, -10, -5, -3, -1, 0, 1, 2, 3]
    for (const vu of tickVus) {
      const tickY = y + h - classicVuToNormalized(vu) * h
      ctx.fillRect(x, tickY, w, 1)
    }
  }

  private drawMeterLabel(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    label: string
  ): void {
    ctx.fillStyle = this.options.labelColor
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
    const displayDb = Number.isFinite(db) ? Math.max(VU_METER_MIN_DB, Math.min(0, db)) : VU_METER_MIN_DB
    const text = displayDb <= VU_METER_MIN_DB + 1 ? '-∞' : `${displayDb.toFixed(1)}`
    ctx.fillStyle = alphaColor(this.options.labelColor, 0.8)
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
    const displayDb = Number.isFinite(db) ? Math.max(VU_METER_MIN_DB, Math.min(0, db)) : VU_METER_MIN_DB
    const text = displayDb <= VU_METER_MIN_DB + 1 ? '-∞' : `${displayDb.toFixed(1)}`
    ctx.fillStyle = alphaColor(this.options.labelColor, 0.8)
    ctx.font = `${Math.min(16, Math.max(8, h * 0.5))}px "JetBrains Mono", monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x + w / 2, y + h / 2)
  }

  private drawCorrelationBar(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    cr: number, cg: number, cb: number,
    labelScale = 0.55,
    labelAlpha = 0.6,
    minLabelSize = 8,
    maxLabelSize = 20,
  ): void {
    const centerX = x + w / 2
    const corr = Math.max(-1, Math.min(1, this.correlation))

    // Background track
    ctx.fillStyle = this.options.trackColor
    ctx.fillRect(x, y, w, h)

    // Center line
    ctx.fillStyle = this.options.scaleColor
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
        ctx.fillStyle = alphaColor(this.options.clipColor, 0.6)
        ctx.fillRect(centerX - indicatorWidth, y, indicatorWidth, h)
      }
    }

    // Labels
    const fontSize = Math.min(maxLabelSize, Math.max(minLabelSize, h * labelScale))
    ctx.font = `${fontSize}px "JetBrains Mono", monospace`
    ctx.textBaseline = 'middle'
    ctx.fillStyle = alphaColor(this.options.labelColor, labelAlpha)
    ctx.textAlign = 'left'
    ctx.fillText('-1', x + 2, y + h / 2)
    ctx.textAlign = 'center'
    ctx.fillText('Ø', centerX, y + h / 2)
    ctx.textAlign = 'right'
    ctx.fillText('+1', x + w - 2, y + h / 2)
  }

  private drawNeedleMode(width: number, height: number): void {
    const ctx = this.ctx
    const { r: cr, g: cg, b: cb } = resolveColorToRgb(this.options.lineColor)
    const devicePixelRatio = getCanvasDevicePixelRatio()
    const faceLayout = resolveVUNeedleFaceLayout(width, height, devicePixelRatio)
    const faceScale = faceLayout.scale * devicePixelRatio
    const faceWidth = faceLayout.width
    const faceHeight = faceLayout.height

    ctx.save()
    ctx.translate(faceLayout.x, faceLayout.y)

    const startAngle = Math.PI * 1.08
    const endAngle = Math.PI * 1.92
    const spanCos = Math.abs(Math.cos(startAngle))
    const corrHeight = 19 * faceScale
    const gap = 4 * faceScale
    const meterAreaHeight = Math.max(1, faceHeight - corrHeight - gap)
    const sidePadding = 11 * faceScale
    const labelFontSize = 23.5 * faceScale
    const outerArcWidth = 22 * faceScale
    const innerArcWidth = 17 * faceScale
    const needleWidth = 3.25 * faceScale
    const pivotY = meterAreaHeight * NEEDLE_PIVOT_FRACTION
    const tickOutward = 5 * faceScale
    const topPadding = 10 * faceScale
    const horizontalLabelAllowance = labelFontSize * 0.32
    const verticalLabelAllowance = labelFontSize * 0.62
    const radiusXByWidth = (faceWidth / 2 - sidePadding) / spanCos
      - outerArcWidth / 2
      - tickOutward
      - horizontalLabelAllowance
    const radiusYByHeight = pivotY
      - outerArcWidth / 2
      - tickOutward
      - verticalLabelAllowance
      - topPadding
    const outerRadiusX = Math.max(34 * faceScale, radiusXByWidth)
    const outerRadiusY = Math.max(34 * faceScale, Math.min(radiusYByHeight, outerRadiusX * 0.92))
    const innerRadiusX = this.options.needleChannels === 'stereo'
      ? outerRadiusX * (1 - NEEDLE_STEREO_GAP_FRACTION)
      : outerRadiusX
    const innerRadiusY = this.options.needleChannels === 'stereo'
      ? outerRadiusY * (1 - NEEDLE_STEREO_GAP_FRACTION)
      : outerRadiusY
    const centerX = faceWidth / 2
    const centerY = Math.max(topPadding + outerRadiusY, pivotY)
    const visualReadings = resolveVUNeedleReadings({
      leftDb: this.needleDisplayL,
      rightDb: this.needleDisplayR,
      leftPeakDb: this.needlePeakL,
      rightPeakDb: this.needlePeakR,
      needleChannels: this.options.needleChannels,
      referenceDb: this.options.referenceDb,
    })
    const readoutReadings = visualReadings

    this.drawNeedleArcs(
      ctx,
      centerX,
      centerY,
      outerRadiusX,
      outerRadiusY,
      innerRadiusX,
      innerRadiusY,
      startAngle,
      endAngle,
      visualReadings,
      outerArcWidth,
      innerArcWidth,
    )
    this.drawSharedNeedleScale(ctx, centerX, centerY, outerRadiusX, outerRadiusY, outerArcWidth, startAngle, endAngle, labelFontSize, faceWidth, sidePadding, tickOutward)
    this.drawNeedlePeakMarkers(ctx, centerX, centerY, outerRadiusX, outerRadiusY, innerRadiusX, innerRadiusY, startAngle, endAngle, readoutReadings, outerArcWidth, innerArcWidth)
    this.drawSharedNeedles(ctx, centerX, centerY, outerRadiusX, outerRadiusY, startAngle, endAngle, visualReadings, needleWidth)
    this.drawNeedleReadouts(ctx, readoutReadings, meterAreaHeight, faceWidth, sidePadding, labelFontSize)

    const barLeft = Math.max(10 * faceScale, sidePadding)
    const barWidth = Math.max(1, faceWidth - barLeft * 2)
    this.drawCorrelationBar(ctx, barLeft, meterAreaHeight + gap, barWidth, corrHeight, cr, cg, cb, 0.72, 0.76, 8 * faceScale, 18 * faceScale)
    ctx.restore()
  }

  private vuToNeedleAngle(vu: number, startAngle: number, endAngle: number): number {
    return startAngle + classicVuToNormalized(vu) * (endAngle - startAngle)
  }

  private needleEllipsePoint(
    centerX: number,
    centerY: number,
    radiusX: number,
    radiusY: number,
    angle: number,
    offset = 0,
  ): { x: number; y: number } {
    return {
      x: centerX + Math.cos(angle) * (radiusX + offset),
      y: centerY + Math.sin(angle) * (radiusY + offset),
    }
  }

  private drawNeedleArcs(
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    outerRadiusX: number,
    outerRadiusY: number,
    innerRadiusX: number,
    innerRadiusY: number,
    startAngle: number,
    endAngle: number,
    readings: VUNeedleReading[],
    outerWidth: number,
    innerWidth: number,
  ): void {
    const hotAngle = this.vuToNeedleAngle(0, startAngle, endAngle)
    const mainReading = readings[readings.length - 1]
    const leftReading = readings.length > 1 ? readings[0] : null
    if (!mainReading) return

    ctx.lineCap = 'butt'
    ctx.strokeStyle = alphaColor(this.getNeedleColor(mainReading), 0.052)
    ctx.lineWidth = outerWidth
    ctx.beginPath()
    ctx.ellipse(centerX, centerY, outerRadiusX, outerRadiusY, 0, startAngle, hotAngle)
    ctx.stroke()
    ctx.strokeStyle = alphaColor(this.options.clipColor, 0.085)
    ctx.beginPath()
    ctx.ellipse(centerX, centerY, outerRadiusX, outerRadiusY, 0, hotAngle, endAngle)
    ctx.stroke()

    if (leftReading) {
      ctx.strokeStyle = alphaColor(this.getNeedleColor(leftReading), 0.04)
      ctx.lineWidth = innerWidth
      ctx.beginPath()
      ctx.ellipse(centerX, centerY, innerRadiusX, innerRadiusY, 0, startAngle, hotAngle)
      ctx.stroke()
      ctx.strokeStyle = alphaColor(this.options.clipColor, 0.065)
      ctx.beginPath()
      ctx.ellipse(centerX, centerY, innerRadiusX, innerRadiusY, 0, hotAngle, endAngle)
      ctx.stroke()
      this.drawNeedleLevelArc(ctx, leftReading, centerX, centerY, innerRadiusX, innerRadiusY, innerWidth, startAngle, hotAngle, endAngle, 0.72)
    }

    this.drawNeedleLevelArc(ctx, mainReading, centerX, centerY, outerRadiusX, outerRadiusY, outerWidth, startAngle, hotAngle, endAngle, 0.95)
  }

  private drawNeedleLevelArc(
    ctx: CanvasRenderingContext2D,
    reading: VUNeedleReading,
    centerX: number,
    centerY: number,
    radiusX: number,
    radiusY: number,
    lineWidth: number,
    startAngle: number,
    hotAngle: number,
    endAngle: number,
    alpha: number,
  ): void {
    const levelAngle = Math.min(endAngle, Math.max(startAngle, this.vuToNeedleAngle(reading.vu, startAngle, endAngle)))
    if (levelAngle <= startAngle) return

    const safeEnd = Math.min(levelAngle, hotAngle)
    if (safeEnd > startAngle) {
      ctx.strokeStyle = alphaColor(this.getNeedleColor(reading), alpha)
      ctx.lineWidth = lineWidth
      ctx.lineCap = 'butt'
      ctx.beginPath()
      ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, startAngle, safeEnd)
      ctx.stroke()
    }

    if (levelAngle > hotAngle) {
      ctx.strokeStyle = alphaColor(this.options.clipColor, Math.min(1, alpha + 0.04))
      ctx.lineWidth = lineWidth
      ctx.lineCap = 'butt'
      ctx.beginPath()
      ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, hotAngle, levelAngle)
      ctx.stroke()
    }
  }

  private drawSharedNeedleScale(
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    radiusX: number,
    radiusY: number,
    outerWidth: number,
    startAngle: number,
    endAngle: number,
    labelFontSize: number,
    width: number,
    sidePadding: number,
    tickOutward: number,
  ): void {
    const averageRadius = (radiusX + radiusY) / 2
    const majorInward = outerWidth + Math.max(5, averageRadius * 0.028)
    const minorInward = outerWidth * 0.65

    ctx.lineCap = 'square'
    for (const { vu, label } of CLASSIC_VU_LABELS) {
      const angle = this.vuToNeedleAngle(vu, startAngle, endAngle)
      const isHot = vu >= 0
      const isMajor = vu <= -10 || vu === 0 || vu > 0
      const shouldShowLabel = isMajor || vu === -5 || vu === -3 || vu === -2 || vu === -1
      const inward = isMajor ? majorInward : minorInward

      ctx.strokeStyle = isHot
        ? alphaColor(this.options.clipColor, 0.92)
        : alphaColor(this.options.scaleColor, 0.72)
      ctx.lineWidth = isMajor ? Math.max(2.25, averageRadius * 0.014) : Math.max(1.15, averageRadius * 0.008)
      const tickStart = this.needleEllipsePoint(centerX, centerY, radiusX, radiusY, angle, outerWidth / 2 + tickOutward)
      const tickEnd = this.needleEllipsePoint(centerX, centerY, radiusX, radiusY, angle, outerWidth / 2 - inward)
      ctx.beginPath()
      ctx.moveTo(tickStart.x, tickStart.y)
      ctx.lineTo(tickEnd.x, tickEnd.y)
      ctx.stroke()

      if (shouldShowLabel) {
        const labelPoint = this.needleEllipsePoint(centerX, centerY, radiusX, radiusY, angle, outerWidth / 2 + tickOutward + labelFontSize * 0.64)
        const x = clamp(labelPoint.x, sidePadding, width - sidePadding)
        const y = labelPoint.y
        ctx.fillStyle = isHot
          ? alphaColor(this.options.clipColor, 0.98)
          : alphaColor(this.options.labelColor, 0.9)
        ctx.font = `${isMajor ? '700 ' : ''}${isMajor ? labelFontSize : labelFontSize * 0.9}px "JetBrains Mono", monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(label, x, y)
      }
    }

    const percentFontSize = labelFontSize * 0.62
    ctx.font = `${percentFontSize}px "JetBrains Mono", monospace`
    ctx.fillStyle = alphaColor(this.options.labelColor, 0.48)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const percentMarks = [
      { vu: -20, label: '0' },
      { vu: -10, label: '20' },
      { vu: -5, label: '40' },
      { vu: -3, label: '60' },
      { vu: -1, label: '80' },
      { vu: 0, label: '100' },
    ]
    for (const { vu, label } of percentMarks) {
      const angle = this.vuToNeedleAngle(vu, startAngle, endAngle)
      const x = centerX + Math.cos(angle) * (radiusX * 0.55)
      const y = centerY + Math.sin(angle) * (radiusY * 0.55)
      if (y < centerY - 4) {
        ctx.fillText(label, x, y)
      }
    }

    const titleFontSize = Math.min(labelFontSize * 0.88, averageRadius * 0.095)
    const titleY = centerY - radiusY * 0.14
    if (titleY > 4) {
      ctx.fillStyle = alphaColor(this.options.labelColor, 0.48)
      ctx.font = `${titleFontSize}px "JetBrains Mono", monospace`
      ctx.fillText('VU', centerX, titleY)
    }
  }

  private drawNeedlePeakMarkers(
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    outerRadiusX: number,
    outerRadiusY: number,
    innerRadiusX: number,
    innerRadiusY: number,
    startAngle: number,
    endAngle: number,
    readings: VUNeedleReading[],
    outerWidth: number,
    innerWidth: number,
  ): void {
    const mainReading = readings[readings.length - 1]
    const leftReading = readings.length > 1 ? readings[0] : null
    if (leftReading) {
      this.drawNeedlePeakMarker(ctx, leftReading, centerX, centerY, innerRadiusX, innerRadiusY, innerWidth, startAngle, endAngle, 0.68)
    }
    if (mainReading) {
      this.drawNeedlePeakMarker(ctx, mainReading, centerX, centerY, outerRadiusX, outerRadiusY, outerWidth, startAngle, endAngle, 0.96)
    }
  }

  private drawNeedlePeakMarker(
    ctx: CanvasRenderingContext2D,
    reading: VUNeedleReading,
    centerX: number,
    centerY: number,
    radiusX: number,
    radiusY: number,
    arcWidth: number,
    startAngle: number,
    endAngle: number,
    alpha: number,
  ): void {
    if (reading.peakDb <= VU_METER_MIN_DB + 1) return

    const angle = this.vuToNeedleAngle(reading.peakVu, startAngle, endAngle)
    const isHot = reading.peakVu >= 0
    const color = isHot ? this.options.clipColor : this.getNeedleColor(reading)
    const averageRadius = (radiusX + radiusY) / 2
    const markerInset = Math.max(3, averageRadius * 0.016)
    const inner = this.needleEllipsePoint(centerX, centerY, radiusX, radiusY, angle, -arcWidth / 2 - markerInset)
    const outer = this.needleEllipsePoint(centerX, centerY, radiusX, radiusY, angle, arcWidth / 2 + markerInset)

    ctx.strokeStyle = alphaColor(color, alpha)
    ctx.lineWidth = Math.max(2.2, averageRadius * 0.011)
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(inner.x, inner.y)
    ctx.lineTo(outer.x, outer.y)
    ctx.stroke()
  }

  private drawSharedNeedles(
    ctx: CanvasRenderingContext2D,
    centerX: number,
    centerY: number,
    radiusX: number,
    radiusY: number,
    startAngle: number,
    endAngle: number,
    readings: VUNeedleReading[],
    needleWidth: number,
  ): void {
    const mainReading = readings[readings.length - 1]
    const leftReading = readings.length > 1 ? readings[0] : null
    const averageRadius = (radiusX + radiusY) / 2
    if (leftReading) {
      this.drawSharedNeedle(ctx, leftReading, centerX, centerY, radiusX, radiusY, startAngle, endAngle, 0.5, needleWidth * 0.72)
    }
    if (mainReading) {
      this.drawSharedNeedle(ctx, mainReading, centerX, centerY, radiusX, radiusY, startAngle, endAngle, 0.96, needleWidth)
      const pivotSize = Math.max(2.3, averageRadius * 0.015)
      ctx.fillStyle = alphaColor(this.getNeedleColor(mainReading), 0.65)
      ctx.fillRect(centerX - pivotSize, centerY - pivotSize, pivotSize * 2, pivotSize * 2)
    }
  }

  private drawSharedNeedle(
    ctx: CanvasRenderingContext2D,
    reading: VUNeedleReading,
    centerX: number,
    centerY: number,
    radiusX: number,
    radiusY: number,
    startAngle: number,
    endAngle: number,
    alpha: number,
    lineWidth: number,
  ): void {
    const angle = this.vuToNeedleAngle(reading.vu, startAngle, endAngle)
    const color = this.getNeedleColor(reading)
    const averageRadius = (radiusX + radiusY) / 2
    const tip = this.needleEllipsePoint(centerX, centerY, radiusX, radiusY, angle, -Math.max(3, averageRadius * 0.012))
    const counterWeight = Math.max(5, averageRadius * 0.034)
    const baseX = centerX - Math.cos(angle) * counterWeight
    const baseY = centerY - Math.sin(angle) * counterWeight

    ctx.strokeStyle = alphaColor(color, alpha)
    ctx.lineWidth = lineWidth
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(baseX, baseY)
    ctx.lineTo(tip.x, tip.y)
    ctx.stroke()

    ctx.fillStyle = alphaColor(color, Math.min(1, alpha + 0.07))
    ctx.beginPath()
    ctx.arc(tip.x, tip.y, Math.max(1.5, lineWidth * 0.75), 0, Math.PI * 2)
    ctx.fill()
  }

  private drawNeedleReadouts(
    ctx: CanvasRenderingContext2D,
    readings: VUNeedleReading[],
    meterAreaHeight: number,
    width: number,
    sidePadding: number,
    labelFontSize: number,
  ): void {
    const mainReading = readings[readings.length - 1]
    if (!mainReading) return

    const leftReading = readings.length > 1 ? readings[0] : null
    const fontSize = labelFontSize * 0.88
    const y = meterAreaHeight - 3
    ctx.font = `${fontSize}px "JetBrains Mono", monospace`
    ctx.textBaseline = 'bottom'

    if (!leftReading) {
      ctx.fillStyle = alphaColor(this.getNeedleColor(mainReading), 0.94)
      ctx.textAlign = 'center'
      ctx.fillText(`${this.formatNeedleDb(mainReading.db)} dB`, width / 2, y)
      return
    }

    ctx.fillStyle = alphaColor(this.getNeedleColor(leftReading), 0.88)
    ctx.textAlign = 'left'
    ctx.fillText(`L  ${this.formatNeedleDb(leftReading.db)} dB`, sidePadding, y)

    ctx.fillStyle = alphaColor(this.getNeedleColor(mainReading), 0.96)
    ctx.textAlign = 'right'
    ctx.fillText(`${this.formatNeedleDb(mainReading.db)} dB  R`, width - sidePadding, y)
  }

  private formatNeedleDb(db: number): string {
    if (!Number.isFinite(db)) return '-∞'
    const displayDb = clamp(db, VU_METER_MIN_DB, VU_METER_MAX_DB)
    return displayDb <= VU_METER_MIN_DB + 1 ? '-∞' : displayDb.toFixed(1)
  }

  private getNeedleColor(reading: VUNeedleReading): string {
    switch (reading.id) {
      case 'left':
        return this.options.needleLeftColor
      case 'right':
        return this.options.needleRightColor
      case 'combined':
        return this.options.needleCombinedColor
    }
  }

  private drawFrame = (): void => {
    const { canvas, ctx, options } = this
    const width = canvas.width
    const height = canvas.height

    if (width <= 0 || height <= 0) {
      return
    }

    const nowMs = performance.now()
    this.processAudio(nowMs)
    this.updateNeedleVisuals(nowMs)

    ctx.clearRect(0, 0, width, height)
    if (options.backgroundColor !== 'transparent') {
      ctx.fillStyle = options.backgroundColor
      ctx.fillRect(0, 0, width, height)
    }

    if (options.mode === 'needle') {
      this.drawNeedleMode(width, height)
    } else {
      this.drawBarMode(width, height)
    }
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
