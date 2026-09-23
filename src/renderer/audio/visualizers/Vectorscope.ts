import { audioEngine } from '../AudioEngine'
import { vectorscope as nativeVectorscope, type VectorscopeNativeAnalyzer } from '../native/index'
import {
  drawVectorscopeGridForMode,
  getVectorscopeLayout,
  transformPointInto,
} from './vectorscopeGrids'
import { MultibandSplitter, MultibandBuffer, createMultibandChunk, type MultibandChunk } from './multibandSplitter'
import { defaultVisualizerSessionSource, type VisualizerSessionSource } from './dataSource'
import { FrameScheduler } from './frameScheduler'
import { VisualizerFrameLoop } from './visualizerFrameLoop'
import { createVectorscopeGpuRenderer, type VectorscopeGpuRenderer, type VectorscopePointContext } from './vectorscopeGpu'
import { normalizeVectorscopeZoomDb, vectorscopeZoomDbToGain } from '../../../types/vectorscope'

export type VectorscopeMode = 'lissajous' | 'polar-unipolar' | 'polar-bipolar' | 'linear-unipolar' | 'linear-bipolar'

export interface VectorscopeDataSource extends VisualizerSessionSource {
  getPendingVectorscopeSamples: () => Array<{ left: Float32Array; right: Float32Array }>
}

export interface VectorscopeOptions {
  lineColor?: string
  lineWidth?: number
  backgroundColor?: string
  showGrid?: boolean
  gridMajorColor?: string
  gridMinorColor?: string
  labelColor?: string
  phaseRiskColor?: string
  bandColors?: {
    low: string
    mid: string
    high: string
  }
  persistence?: number
  displayPoints?: number
  mode?: VectorscopeMode
  zoomDb?: number
  multiband?: boolean
  dataSource?: VectorscopeDataSource
  frameScheduler?: FrameScheduler
  nativeAnalyzer?: VectorscopeNativeAnalyzer | null
}

type ResolvedVectorscopeOptions = Required<Omit<VectorscopeOptions, 'dataSource' | 'frameScheduler' | 'nativeAnalyzer'>>

const defaultOptions: ResolvedVectorscopeOptions = {
  lineColor: '#00ffff',
  lineWidth: 1.5,
  backgroundColor: 'transparent',
  showGrid: true,
  gridMajorColor: 'rgba(255, 255, 255, 0.1)',
  gridMinorColor: 'rgba(255, 255, 255, 0.05)',
  labelColor: 'rgba(255, 255, 255, 0.55)',
  phaseRiskColor: '#8bafbd',
  bandColors: {
    low: '#ff4444',
    mid: '#44dd44',
    high: '#4488ff',
  },
  persistence: 0.10,
  displayPoints: 4096,
  mode: 'lissajous',
  zoomDb: 0,
  multiband: false,
}

const defaultVectorscopeDataSource: VectorscopeDataSource = {
  getPendingVectorscopeSamples: () => audioEngine.flushPendingVectorscopeSamples(),
  ...defaultVisualizerSessionSource,
}

const BAND_ORDER = ['low', 'mid', 'high'] as const

export class Vectorscope {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private offscreenCanvas: HTMLCanvasElement
  private offscreenCtx: CanvasRenderingContext2D
  private gpuRenderer: VectorscopeGpuRenderer | null = null
  private staticLayerCanvas: HTMLCanvasElement
  private staticLayerCtx: CanvasRenderingContext2D
  private options: ResolvedVectorscopeOptions
  private dataSource: VectorscopeDataSource
  private nativeAnalyzer: VectorscopeNativeAnalyzer | null
  private frameLoop: VisualizerFrameLoop
  private nativeInitialized = false
  private lastSampleRate = 0
  private unsubscribeSessionChange: (() => void) | null = null
  private splitter: MultibandSplitter = new MultibandSplitter()
  private multibandBuffer: MultibandBuffer = new MultibandBuffer()
  private multibandScratch: MultibandChunk = createMultibandChunk(0)
  private multibandPointScratch: MultibandChunk = createMultibandChunk(0)
  private nativePointX = new Float32Array(0)
  private nativePointY = new Float32Array(0)
  private pushScratchL = new Float32Array(0)
  private pushScratchR = new Float32Array(0)
  private staticLayerKey = ''
  private projectionGain: number
  private projectedPoint = { dx: 0, dy: 0 }
  private projectionInputsL = new Float32Array(0)
  private projectionInputsR = new Float32Array(0)
  private projectionX = new Float64Array(0)
  private projectionY = new Float64Array(0)
  private projectionOffset = 0
  private projectionCacheEnabled = false

  constructor(canvas: HTMLCanvasElement, options: VectorscopeOptions = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2D context')
    this.ctx = ctx

    const { dataSource, frameScheduler, nativeAnalyzer, ...optionOverrides } = options
    this.options = {
      ...defaultOptions,
      ...optionOverrides,
      zoomDb: normalizeVectorscopeZoomDb(optionOverrides.zoomDb ?? defaultOptions.zoomDb),
    }
    this.projectionGain = vectorscopeZoomDbToGain(this.options.zoomDb)
    this.dataSource = dataSource ?? defaultVectorscopeDataSource
    this.nativeAnalyzer = nativeAnalyzer === undefined ? nativeVectorscope : nativeAnalyzer
    this.frameLoop = new VisualizerFrameLoop({
      frameScheduler,
      shouldRun: () => this.dataSource.isPlaying(),
      onFrame: this.drawFrame,
    })

    this.offscreenCanvas = document.createElement('canvas')
    this.offscreenCanvas.width = canvas.width
    this.offscreenCanvas.height = canvas.height
    const offCtx = this.offscreenCanvas.getContext('2d')
    if (!offCtx) throw new Error('Could not get offscreen 2D context')
    this.offscreenCtx = offCtx
    this.staticLayerCanvas = document.createElement('canvas')
    const staticLayerCtx = this.staticLayerCanvas.getContext('2d')
    if (!staticLayerCtx) throw new Error('Could not get static offscreen 2D context')
    this.staticLayerCtx = staticLayerCtx
    // Batching pays off consistently for the three multiband point layers.
    // The ordinary layer keeps Canvas: GPU interop can cost more CPU time there.
    if (this.options.multiband) {
      this.gpuRenderer = createVectorscopeGpuRenderer(this.pointColors())
    }

    this.initNative()
    this.subscribeToSessionChanges()
  }

  private pointColors(): string[] {
    return [this.options.lineColor, ...BAND_ORDER.map(band => this.options.bandColors[band])]
  }

  private useCanvasRenderer(): void {
    this.gpuRenderer?.copyHistoryTo(this.offscreenCtx)
    this.gpuRenderer?.dispose()
    this.gpuRenderer = null
  }

  private subscribeToSessionChanges(): void {
    if (this.unsubscribeSessionChange) {
      this.unsubscribeSessionChange()
    }
    this.unsubscribeSessionChange = this.dataSource.subscribeToSessionChanges(() => {
      this.resetDisplay()
    })
  }

  private initNative(): void {
    if (this.isNativeAvailable() && !this.nativeInitialized) {
      const sampleRate = this.dataSource.getSampleRate()
      this.lastSampleRate = sampleRate
      this.nativeAnalyzer?.setSampleRate(sampleRate)
      this.nativeInitialized = true
      console.log(`Vectorscope: Using native DSP (${sampleRate}Hz)`)
    } else if (!this.isNativeAvailable()) {
      console.log('Vectorscope: Using JavaScript fallback')
    }
  }

  private updateSampleRateIfNeeded(): void {
    const currentRate = this.dataSource.getSampleRate()
    if (currentRate !== this.lastSampleRate && currentRate > 0) {
      this.lastSampleRate = currentRate
      if (this.isNativeAvailable()) {
        this.nativeAnalyzer?.setSampleRate(currentRate)
      }
      this.splitter.configure(currentRate)
    }
  }

  private resetDisplay(): void {
    if (this.isNativeAvailable()) {
      this.nativeAnalyzer?.reset()
    }
    this.splitter.reset()
    this.multibandBuffer.reset()
    this.projectionInputsL.fill(NaN)
    this.gpuRenderer?.clear()
    this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height)
    this.invalidate()
  }

  setOptions(options: Partial<VectorscopeOptions>): void {
    const { dataSource, frameScheduler: _frameScheduler, nativeAnalyzer, ...optionUpdates } = options
    const nextOptions: ResolvedVectorscopeOptions = {
      ...this.options,
      ...optionUpdates,
      zoomDb: normalizeVectorscopeZoomDb(optionUpdates.zoomDb ?? this.options.zoomDb),
    }
    const multibandChanged = nextOptions.multiband !== this.options.multiband
    const modeChanged = nextOptions.mode !== this.options.mode
    const zoomChanged = nextOptions.zoomDb !== this.options.zoomDb
    this.options = nextOptions
    if (multibandChanged) {
      // Changing bands already resets display history below, so no transfer is
      // needed. Ordinary mode also releases the now-unused GPU context.
      this.gpuRenderer?.dispose()
      this.gpuRenderer = nextOptions.multiband ? createVectorscopeGpuRenderer(this.pointColors()) : null
    }
    if (this.gpuRenderer && !this.gpuRenderer.setPalette(this.pointColors())) {
      this.useCanvasRenderer()
    }
    this.projectionGain = vectorscopeZoomDbToGain(nextOptions.zoomDb)
    let shouldResetDisplay = false
    if (nativeAnalyzer !== undefined && nativeAnalyzer !== this.nativeAnalyzer) {
      this.nativeAnalyzer = nativeAnalyzer
      this.nativeInitialized = false
      this.initNative()
      shouldResetDisplay = true
    }
    if (dataSource && dataSource !== this.dataSource) {
      this.dataSource = dataSource
      this.subscribeToSessionChanges()
      shouldResetDisplay = true
    }
    if (multibandChanged || modeChanged || zoomChanged) {
      shouldResetDisplay = true
    }
    if (shouldResetDisplay) {
      this.resetDisplay()
    }
    this.staticLayerKey = ''
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
    this.staticLayerKey = ''
    this.invalidate()
  }

  private getProjectionScale(radius: number): number {
    return radius
  }

  private drawFrame = (): void => {
    const { canvas, ctx, offscreenCanvas, offscreenCtx, options } = this
    const width = canvas.width
    const height = canvas.height
    if (width <= 0 || height <= 0) return

    const layout = getVectorscopeLayout(width, height, options.mode)
    const centerX = layout.centerX
    const centerY = layout.centerY
    const scale = this.getProjectionScale(layout.radius)

    if (offscreenCanvas.width !== width || offscreenCanvas.height !== height) {
      offscreenCanvas.width = width
      offscreenCanvas.height = height
    }

    this.updateSampleRateIfNeeded()

    if (!this.dataSource.isPlaying()) {
      this.renderStaticLayer()
      return
    }

    if (this.gpuRenderer && !this.gpuRenderer.beginFrame(width, height, options.persistence, options.lineWidth * (window.devicePixelRatio || 1))) {
      this.useCanvasRenderer()
    }
    const pointContext = this.gpuRenderer ?? offscreenCtx
    if (!this.gpuRenderer) {
      offscreenCtx.globalCompositeOperation = 'destination-in'
      offscreenCtx.fillStyle = `rgba(255, 255, 255, ${options.persistence})`
      offscreenCtx.fillRect(0, 0, width, height)
      offscreenCtx.globalCompositeOperation = 'source-over'
    }

    const pendingSamples = this.dataSource.getPendingVectorscopeSamples()

    if (options.multiband) {
      if (!this.drawNativeMultibandPoints(pointContext, pendingSamples, centerX, centerY, scale)) {
        this.drawMultibandPoints(pointContext, pendingSamples, centerX, centerY, scale)
      }
    } else if (this.isNativeAvailable()) {
      if (pendingSamples.length > 0) {
        const { left, right } = this.concatStereoChunks(pendingSamples)
        this.nativeAnalyzer?.pushSamples(left, right)
      }

      const count = this.fillNativePoints(options.displayPoints)
      if (count > 0) {
        this.prepareProjectionCache(pendingSamples, 1)
        this.drawPoints(pointContext, this.nativePointX, this.nativePointY, count, centerX, centerY, scale)
      }
    } else {
      this.drawFallbackPoints(pointContext, pendingSamples, centerX, centerY, scale)
    }

    this.renderStaticLayer()
    if (this.gpuRenderer) this.gpuRenderer.present(ctx)
    else ctx.drawImage(offscreenCanvas, 0, 0)
  }

  private isNativeAvailable(): boolean {
    return Boolean(this.nativeAnalyzer) && this.nativeAnalyzer?.isAvailable?.() !== false
  }

  private isNativeMultibandAvailable(): boolean {
    return this.isNativeAvailable()
      && Boolean(this.nativeAnalyzer?.pushMultibandSamples)
      && Boolean(this.nativeAnalyzer?.getMultibandPoints)
      && this.nativeAnalyzer?.isMultibandAvailable?.() !== false
  }

  private renderStaticLayer(): void {
    this.ensureStaticLayer()
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.ctx.drawImage(this.staticLayerCanvas, 0, 0)
  }

  private ensureStaticLayer(): void {
    const { canvas, options } = this
    const key = [
      canvas.width,
      canvas.height,
      options.backgroundColor,
      options.showGrid,
      options.gridMajorColor,
      options.gridMinorColor,
      options.labelColor,
      options.phaseRiskColor,
      options.mode,
      options.zoomDb,
    ].join(':')

    if (this.staticLayerKey === key) {
      return
    }

    this.staticLayerCanvas.width = canvas.width
    this.staticLayerCanvas.height = canvas.height
    this.staticLayerCtx.clearRect(0, 0, canvas.width, canvas.height)

    if (options.backgroundColor !== 'transparent') {
      this.staticLayerCtx.fillStyle = options.backgroundColor
      this.staticLayerCtx.fillRect(0, 0, canvas.width, canvas.height)
    }

    if (options.showGrid) {
      const dpr = window.devicePixelRatio || 1
      drawVectorscopeGridForMode(
        this.staticLayerCtx,
        canvas.width,
        canvas.height,
        options.gridMajorColor,
        options.gridMinorColor,
        options.labelColor,
        options.mode,
        options.phaseRiskColor,
        options.zoomDb,
        dpr,
      )
    }

    this.staticLayerKey = key
  }

  private drawPoints(
    ctx: VectorscopePointContext,
    x: Float32Array,
    y: Float32Array,
    count: number,
    centerX: number,
    centerY: number,
    scale: number
  ): void {
    const { options } = this
    const mode = options.mode
    const cachePoints = this.projectionCacheEnabled
    const dpr = window.devicePixelRatio || 1
    const dotSize = options.lineWidth * dpr

    const segments = 8
    const pointsPerSegment = Math.ceil(count / segments)

    for (let seg = 0; seg < segments; seg++) {
      const startIdx = seg * pointsPerSegment
      const endIdx = Math.min((seg + 1) * pointsPerSegment, count)
      if (startIdx >= count) break

      const alpha = 0.15 + 0.85 * (seg / Math.max(segments - 1, 1))

      ctx.fillStyle = options.lineColor
      ctx.globalAlpha = alpha

      for (let i = startIdx; i < endIdx; i++) {
        const cacheIndex = cachePoints ? (this.projectionOffset + i) % options.displayPoints : -1
        this.drawProjectedDot(ctx, y[i], x[i], mode, centerX, centerY, scale, dotSize, cacheIndex)
      }
    }
    ctx.globalAlpha = 1.0
  }

  private drawFallbackPoints(
    ctx: VectorscopePointContext,
    pendingSamples: { left: Float32Array; right: Float32Array }[],
    centerX: number,
    centerY: number,
    scale: number
  ): void {
    if (pendingSamples.length === 0) return

    const { options } = this
    const mode = options.mode
    const dpr = window.devicePixelRatio || 1
    const dotSize = options.lineWidth * dpr

    ctx.fillStyle = options.lineColor
    ctx.globalAlpha = 0.8

    for (const chunk of pendingSamples) {
      for (let i = 0; i < chunk.left.length; i++) {
        this.drawProjectedDot(ctx, chunk.left[i], chunk.right[i], mode, centerX, centerY, scale, dotSize)
      }
    }
    ctx.globalAlpha = 1.0
  }

  private drawMultibandPoints(
    ctx: VectorscopePointContext,
    pendingSamples: { left: Float32Array; right: Float32Array }[],
    centerX: number,
    centerY: number,
    scale: number
  ): void {
    const { options } = this
    const mode = options.mode
    const dpr = window.devicePixelRatio || 1
    const dotSize = options.lineWidth * dpr

    const sampleRate = this.dataSource.getSampleRate()
    if (sampleRate > 0) {
      this.splitter.configure(sampleRate)
    }

    for (const chunk of pendingSamples) {
      const bands = this.ensureMultibandScratch(chunk.left.length, chunk.right.length)
      const count = this.splitter.splitInto(chunk.left, chunk.right, bands)
      this.multibandBuffer.push(bands, count)
    }

    const result = this.ensureMultibandPointScratch(options.displayPoints)
    const count = this.multibandBuffer.fillPointsInto(result, options.displayPoints)
    if (count === 0) return
    this.prepareProjectionCache(pendingSamples, 3)
    const cachePoints = this.projectionCacheEnabled

    const segments = 8
    const pointsPerSegment = Math.ceil(count / segments)

    for (let seg = 0; seg < segments; seg++) {
      const startIdx = seg * pointsPerSegment
      const endIdx = Math.min((seg + 1) * pointsPerSegment, count)
      if (startIdx >= count) break

      const alpha = 0.15 + 0.85 * (seg / Math.max(segments - 1, 1))
      ctx.globalAlpha = alpha

      for (let bandIndex = 0; bandIndex < BAND_ORDER.length; bandIndex++) {
        const band = BAND_ORDER[bandIndex]
        const bandData = result[band]
        ctx.fillStyle = options.bandColors[band]

        for (let i = startIdx; i < endIdx; i++) {
          const cacheIndex = cachePoints ? bandIndex * options.displayPoints + (this.projectionOffset + i) % options.displayPoints : -1
          this.drawProjectedDot(ctx, bandData.left[i], bandData.right[i], mode, centerX, centerY, scale, dotSize, cacheIndex)
        }
      }
    }
    ctx.globalAlpha = 1.0
  }

  private drawNativeMultibandPoints(
    ctx: VectorscopePointContext,
    pendingSamples: { left: Float32Array; right: Float32Array }[],
    centerX: number,
    centerY: number,
    scale: number
  ): boolean {
    if (!this.isNativeMultibandAvailable()) {
      return false
    }

    if (pendingSamples.length > 0) {
      const { left, right } = this.concatStereoChunks(pendingSamples)
      this.nativeAnalyzer?.pushMultibandSamples?.(left, right)
    }

    const result = this.nativeAnalyzer?.getMultibandPoints?.(this.options.displayPoints)
    if (!result) {
      return false
    }

    const count = Math.min(result.count, Math.floor(result.data.length / 6), this.options.displayPoints)
    if (count === 0) {
      return true
    }
    this.prepareProjectionCache(pendingSamples, 3)
    const cachePoints = this.projectionCacheEnabled

    const mode = this.options.mode
    const dpr = window.devicePixelRatio || 1
    const dotSize = this.options.lineWidth * dpr
    const segments = 8
    const pointsPerSegment = Math.ceil(count / segments)
    const bandOffsets: Record<(typeof BAND_ORDER)[number], [number, number]> = {
      low: [0, 1],
      mid: [2, 3],
      high: [4, 5],
    }

    for (let seg = 0; seg < segments; seg++) {
      const startIdx = seg * pointsPerSegment
      const endIdx = Math.min((seg + 1) * pointsPerSegment, count)
      if (startIdx >= count) break

      const alpha = 0.15 + 0.85 * (seg / Math.max(segments - 1, 1))
      ctx.globalAlpha = alpha

      for (let bandIndex = 0; bandIndex < BAND_ORDER.length; bandIndex++) {
        const band = BAND_ORDER[bandIndex]
        const [leftOffset, rightOffset] = bandOffsets[band]
        ctx.fillStyle = this.options.bandColors[band]

        for (let i = startIdx; i < endIdx; i++) {
          const offset = i * 6
          const cacheIndex = cachePoints ? bandIndex * this.options.displayPoints + (this.projectionOffset + i) % this.options.displayPoints : -1
          this.drawProjectedDot(ctx, result.data[offset + leftOffset], result.data[offset + rightOffset], mode, centerX, centerY, scale, dotSize, cacheIndex)
        }
      }
    }

    ctx.globalAlpha = 1.0
    return true
  }

  private ensureNativePointBuffers(displayPoints: number): void {
    if (this.nativePointX.length !== displayPoints) {
      this.nativePointX = new Float32Array(displayPoints)
      this.nativePointY = new Float32Array(displayPoints)
    }
  }

  private fillNativePoints(displayPoints: number): number {
    this.ensureNativePointBuffers(displayPoints)
    return this.nativeAnalyzer?.fillPoints(this.nativePointX, this.nativePointY) ?? 0
  }

  private ensureMultibandScratch(leftLength: number, rightLength: number): MultibandChunk {
    const length = Math.min(leftLength, rightLength)
    if (this.multibandScratch.low.left.length < length) {
      this.multibandScratch = createMultibandChunk(length)
    }
    return this.multibandScratch
  }

  private ensureMultibandPointScratch(displayPoints: number): MultibandChunk {
    if (this.multibandPointScratch.low.left.length !== displayPoints) {
      this.multibandPointScratch = createMultibandChunk(displayPoints)
    }
    return this.multibandPointScratch
  }

  private concatStereoChunks(chunks: Array<{ left: Float32Array; right: Float32Array }>): { left: Float32Array; right: Float32Array } {
    if (chunks.length === 1) return chunks[0]

    let totalLength = 0
    for (const chunk of chunks) {
      totalLength += Math.min(chunk.left.length, chunk.right.length)
    }

    if (this.pushScratchL.length < totalLength) {
      this.pushScratchL = new Float32Array(totalLength)
      this.pushScratchR = new Float32Array(totalLength)
    }

    const left = this.pushScratchL.length === totalLength
      ? this.pushScratchL
      : this.pushScratchL.subarray(0, totalLength)
    const right = this.pushScratchR.length === totalLength
      ? this.pushScratchR
      : this.pushScratchR.subarray(0, totalLength)

    let offset = 0
    for (const chunk of chunks) {
      const len = Math.min(chunk.left.length, chunk.right.length)
      left.set(chunk.left.subarray(0, len), offset)
      right.set(chunk.right.subarray(0, len), offset)
      offset += len
    }

    return { left, right }
  }

  private prepareProjectionCache(
    pendingSamples: { left: Float32Array; right: Float32Array }[],
    bands: number,
  ): void {
    // XY/Linear projections are cheaper to recalculate than to look up.
    this.projectionCacheEnabled = this.options.mode === 'polar-bipolar' || this.options.mode === 'polar-unipolar'
    if (!this.projectionCacheEnabled) return
    const capacity = this.options.displayPoints
    const length = capacity * bands
    if (this.projectionInputsL.length !== length) {
      this.projectionInputsL = new Float32Array(length)
      this.projectionInputsL.fill(NaN)
      this.projectionInputsR = new Float32Array(length)
      this.projectionX = new Float64Array(length)
      this.projectionY = new Float64Array(length)
      this.projectionOffset = 0
    }
    // The history advances by the new sample count. Align cached coordinates
    // with that history, but always check both inputs before reusing a point:
    // an analyzer may return a shorter or different snapshot at any time.
    let newSamples = 0
    for (const chunk of pendingSamples) newSamples += Math.min(chunk.left.length, chunk.right.length)
    this.projectionOffset = (this.projectionOffset + newSamples) % capacity
  }

  private drawProjectedDot(
    ctx: VectorscopePointContext,
    left: number,
    right: number,
    mode: VectorscopeMode,
    centerX: number,
    centerY: number,
    scale: number,
    dotSize: number,
    cacheIndex: number = -1,
  ): void {
    // All dots share the zoom gain; reuse the projection result without changing
    // the order or alpha of individual draws (overlapping dots must still blend).
    const point = this.projectedPoint
    if (cacheIndex >= 0 && this.projectionInputsL[cacheIndex] === left && this.projectionInputsR[cacheIndex] === right) {
      point.dx = this.projectionX[cacheIndex]
      point.dy = this.projectionY[cacheIndex]
    } else {
      transformPointInto(left, right, mode, this.projectionGain, point)
      if (cacheIndex >= 0) {
        this.projectionInputsL[cacheIndex] = left
        this.projectionInputsR[cacheIndex] = right
        this.projectionX[cacheIndex] = point.dx
        this.projectionY[cacheIndex] = point.dy
      }
    }

    const { dx, dy } = point
    const px = centerX + dx * scale
    const py = centerY - dy * scale
    ctx.fillRect(px - dotSize / 2, py - dotSize / 2, dotSize, dotSize)
  }

  dispose(): void {
    this.stop()
    this.frameLoop.dispose()
    this.gpuRenderer?.dispose()
    this.gpuRenderer = null

    if (this.unsubscribeSessionChange) {
      this.unsubscribeSessionChange()
      this.unsubscribeSessionChange = null
    }

    if (this.isNativeAvailable()) {
      this.nativeAnalyzer?.reset()
    }
  }
}
