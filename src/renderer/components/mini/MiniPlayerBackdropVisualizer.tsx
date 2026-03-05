import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { MiniPlayerVisualizerMode } from '../../../types/miniPlayer'
import {
  AMBIENT_SPECTRUM_MAX_FREQ,
  AMBIENT_SPECTRUM_MIN_FREQ,
  applyTilt,
  clamp,
  colorWithAlpha,
  frequencyAtX,
  lerp,
  neutralHaloColorForLuminance,
  parseColorToRgb,
  relativeLuminance,
  saturationFromRgb,
  tiltOffsetAtFrequency
} from '../visualizers/ambientSpectrumMath'
import {
  isNativeAvailable,
  oscilloscope as nativeOscilloscope,
  OSCILLOSCOPE_BUFFER_SIZE,
  spectrum as nativeSpectrum
} from '../../audio/native'
import { getNormalizedOscilloscopeDisplaySamples } from '../../audio/native/oscilloscopeDisplaySamples'

interface MiniPlayerBackdropVisualizerProps {
  mode: MiniPlayerVisualizerMode
  lineColor: string
  isIdle: boolean
  artworkDataUrl: string | null
  layoutMode: 'tiny' | 'compact' | 'wide' | 'hero'
}

const OSCILLOSCOPE_WARMUP_SAMPLES = 4096
const SPECTRUM_MIN_DB = -90
const SPECTRUM_MAX_DB = -10
const SPECTRUM_SMOOTHING_BASE = 0.9
const ARTWORK_SAMPLE_SIZE = 28
const ARTWORK_MIN_ALPHA = 24
const DEFAULT_BACKDROP_METRICS = {
  luminance: 0.24,
  saturation: 0.34
}
const MINI_MAX_PENDING_CHUNKS = 24
const MINI_MAX_DPR = 1.5
const MINI_COMPACT_SPECTRUM_POINT_CAP = 320
const MINI_WIDE_SPECTRUM_POINT_CAP = 520
const MINI_OSCILLOSCOPE_POINT_CAP = 1024
const MINI_OSCILLOSCOPE_UNDERFILL_POINT_CAP = 640

interface BackdropMetrics {
  luminance: number
  saturation: number
}

interface VisibilityProfile {
  visibilityBoost: number
  contrastRisk: number
  backdropLuminance: number
  haloColor: string
  blendMode: 'screen' | 'normal'
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    let settled = false

    const finish = (next: () => void) => {
      if (settled) return
      settled = true
      next()
    }

    image.decoding = 'async'
    image.onload = () => finish(() => resolve(image))
    image.onerror = () => finish(() => reject(new Error('Failed to decode mini-player artwork')))
    image.src = source

    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      finish(() => resolve(image))
    }
  })
}

function sampleArtworkMetrics(image: HTMLImageElement): BackdropMetrics | null {
  const canvas = document.createElement('canvas')
  canvas.width = ARTWORK_SAMPLE_SIZE
  canvas.height = ARTWORK_SAMPLE_SIZE

  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null

  try {
    context.clearRect(0, 0, ARTWORK_SAMPLE_SIZE, ARTWORK_SAMPLE_SIZE)
    context.drawImage(image, 0, 0, ARTWORK_SAMPLE_SIZE, ARTWORK_SAMPLE_SIZE)
    const data = context.getImageData(0, 0, ARTWORK_SAMPLE_SIZE, ARTWORK_SAMPLE_SIZE).data

    let luminanceSum = 0
    let saturationSum = 0
    let totalWeight = 0

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3]
      if (alpha < ARTWORK_MIN_ALPHA) continue

      const weight = alpha / 255
      if (weight <= 0) continue

      const rgb = { r: data[i], g: data[i + 1], b: data[i + 2] }
      luminanceSum += relativeLuminance(rgb) * weight
      saturationSum += saturationFromRgb(rgb) * weight
      totalWeight += weight
    }

    if (totalWeight <= 0) return null

    return {
      luminance: clamp(luminanceSum / totalWeight, 0, 1),
      saturation: clamp(saturationSum / totalWeight, 0, 1)
    }
  } catch {
    return null
  }
}

async function sampleBackdropMetrics(source: string): Promise<BackdropMetrics | null> {
  if (!source || typeof source !== 'string') return null

  try {
    const image = await loadImage(source)
    return sampleArtworkMetrics(image)
  } catch {
    return null
  }
}

function deriveFallbackBackdropMetrics(lineColor: string): BackdropMetrics {
  const parsed = parseColorToRgb(lineColor)
  if (!parsed) {
    return DEFAULT_BACKDROP_METRICS
  }

  const lineLuminance = relativeLuminance(parsed)
  const lineSaturation = saturationFromRgb(parsed)

  return {
    luminance: clamp((lineLuminance * 0.44) + 0.12, 0.14, 0.58),
    saturation: clamp(lineSaturation * 0.66, 0.08, 0.72)
  }
}

function resolveVisibilityProfile(
  mode: MiniPlayerVisualizerMode,
  lineColor: string,
  backdropMetrics: BackdropMetrics
): VisibilityProfile {
  const lineRgb = parseColorToRgb(lineColor)
  const lineLuminance = lineRgb ? relativeLuminance(lineRgb) : 0.58
  const lineSaturation = lineRgb ? saturationFromRgb(lineRgb) : 0.5

  // Scrim and blur darken the effective background, so we bias sampled luminance lower.
  const backdropLuminance = clamp((backdropMetrics.luminance * 0.68) + 0.12, 0, 1)
  const backdropSaturation = clamp(backdropMetrics.saturation, 0, 1)
  const luminanceDelta = Math.abs(lineLuminance - backdropLuminance)

  const contrastRisk = clamp(1 - (luminanceDelta / 0.42), 0, 1)
  const desaturationRisk = clamp(1 - (backdropSaturation / 0.32), 0, 1)
  const lineDesaturationRisk = clamp(1 - (lineSaturation / 0.24), 0, 1)
  const visibilityBoost = clamp(
    (contrastRisk * 0.72) +
    (desaturationRisk * 0.18) +
    (lineDesaturationRisk * 0.10),
    0,
    1
  )

  const brightConflict = backdropLuminance > 0.72 && lineLuminance > 0.56
  const darkConflict = backdropLuminance < 0.2 && lineLuminance < 0.34
  const lowDeltaConflict = luminanceDelta < 0.16
  const blendMode: 'screen' | 'normal' = (mode !== 'off' && (brightConflict || darkConflict || lowDeltaConflict || contrastRisk > 0.60))
    ? 'normal'
    : 'screen'

  return {
    visibilityBoost,
    contrastRisk,
    backdropLuminance,
    haloColor: neutralHaloColorForLuminance(backdropLuminance),
    blendMode
  }
}

function mixRgb(
  base: { r: number; g: number; b: number },
  tint: { r: number; g: number; b: number },
  amount: number
): { r: number; g: number; b: number } {
  const safeAmount = clamp(amount, 0, 1)
  const mixChannel = (from: number, to: number) => Math.round((from * (1 - safeAmount)) + (to * safeAmount))
  return {
    r: mixChannel(base.r, tint.r),
    g: mixChannel(base.g, tint.g),
    b: mixChannel(base.b, tint.b),
  }
}

function adaptiveMiniUnderfillColor(
  accentColor: string,
  backdropLuminance: number,
  tintAmount: number,
  alpha: number
): string {
  const safeAlpha = clamp(alpha, 0, 1)
  const accent = parseColorToRgb(accentColor) ?? { r: 56, g: 189, b: 248 }
  const neutral = backdropLuminance < 0.56
    ? { r: 246, g: 248, b: 252 }
    : { r: 20, g: 24, b: 30 }
  const mixed = mixRgb(neutral, accent, tintAmount)
  return `rgba(${mixed.r}, ${mixed.g}, ${mixed.b}, ${safeAlpha})`
}

function resolveOpacity(
  mode: MiniPlayerVisualizerMode,
  layoutMode: 'tiny' | 'compact' | 'wide' | 'hero',
  idle: boolean,
  profile: VisibilityProfile
): number {
  if (mode === 'off') return 0

  const isCompactLayout = layoutMode === 'tiny' || layoutMode === 'compact'
  const baseActive = mode === 'oscilloscope'
    ? (isCompactLayout ? 0.28 : 0.30)
    : (isCompactLayout ? 0.28 : 0.36)
  const baseIdle = isCompactLayout ? 0.15 : 0.19
  const baseOpacity = idle ? baseIdle : baseActive

  const blendBonus = profile.blendMode === 'normal' ? (idle ? 0.03 : 0.07) : 0
  const adaptiveBoost = idle
    ? lerp(0.03, 0.12, profile.visibilityBoost)
    : lerp(0.04, 0.24, profile.visibilityBoost)

  const minOpacity = isCompactLayout
    ? (idle ? 0.17 : 0.30)
    : (idle ? 0.19 : 0.34)
  const maxOpacity = isCompactLayout
    ? (idle ? 0.31 : 0.48)
    : (idle ? 0.35 : 0.64)

  return clamp(baseOpacity + blendBonus + adaptiveBoost, minOpacity, maxOpacity)
}

function getNativeSpectrumSmoothing(fftSize: number): number {
  const base = Math.min(0.99, Math.max(0, SPECTRUM_SMOOTHING_BASE))
  const fftRatio = Math.max(0.5, fftSize / 2048)
  return Math.min(0.99, Math.max(0, Math.pow(base, fftRatio)))
}

export default function MiniPlayerBackdropVisualizer({
  mode,
  lineColor,
  isIdle,
  artworkDataUrl,
  layoutMode
}: MiniPlayerBackdropVisualizerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animationRef = useRef<number | null>(null)
  const canvasSizeRef = useRef({ width: 0, height: 0 })
  const modeRef = useRef(mode)
  const layoutModeRef = useRef(layoutMode)
  const lineColorRef = useRef(lineColor)
  const idleRef = useRef(isIdle)

  const pendingLeftChunksRef = useRef<Float32Array[]>([])
  const pendingMonoChunksRef = useRef<Float32Array[]>([])
  const sampleRateRef = useRef(48000)
  const pitchLockRef = useRef(true)
  const oscilloscopeUnderfillEnabledRef = useRef(false)
  const fftSizeRef = useRef(2048)
  const samplesReceivedRef = useRef(0)
  const spectrumDataRef = useRef<Float32Array | null>(null)
  const configuredSampleRateRef = useRef(0)
  const configuredFftSizeRef = useRef(0)
  const configuredPitchLockRef = useRef<boolean | null>(null)
  const visibilityProfileRef = useRef<VisibilityProfile>(
    resolveVisibilityProfile(mode, lineColor, DEFAULT_BACKDROP_METRICS)
  )
  const [sampledBackdropMetrics, setSampledBackdropMetrics] = useState<BackdropMetrics | null>(null)

  useEffect(() => {
    modeRef.current = mode
    if (mode === 'off') {
      pendingLeftChunksRef.current = []
      pendingMonoChunksRef.current = []
      spectrumDataRef.current = null
      samplesReceivedRef.current = 0
      if (isNativeAvailable()) {
        nativeOscilloscope.reset()
        nativeSpectrum.reset()
      }
    }
  }, [mode])

  useEffect(() => {
    layoutModeRef.current = layoutMode
  }, [layoutMode])

  useEffect(() => {
    lineColorRef.current = lineColor
  }, [lineColor])

  useEffect(() => {
    idleRef.current = isIdle
  }, [isIdle])

  useEffect(() => {
    let isActive = true

    if (!artworkDataUrl) {
      setSampledBackdropMetrics(null)
      return () => {
        isActive = false
      }
    }

    void sampleBackdropMetrics(artworkDataUrl).then((metrics) => {
      if (!isActive) return
      setSampledBackdropMetrics(metrics)
    })

    return () => {
      isActive = false
    }
  }, [artworkDataUrl])

  const fallbackBackdropMetrics = useMemo(
    () => deriveFallbackBackdropMetrics(lineColor),
    [lineColor]
  )

  const activeBackdropMetrics = sampledBackdropMetrics ?? fallbackBackdropMetrics

  const visibilityProfile = useMemo(
    () => resolveVisibilityProfile(mode, lineColor, activeBackdropMetrics),
    [mode, lineColor, activeBackdropMetrics]
  )

  useEffect(() => {
    visibilityProfileRef.current = visibilityProfile
  }, [visibilityProfile])

  const visualizerStyle = useMemo(() => {
    const opacity = resolveOpacity(mode, layoutMode, isIdle, visibilityProfile)
    return {
      '--mini-visualizer-opacity': opacity.toFixed(3),
      '--mini-visualizer-blend': visibilityProfile.blendMode,
    } as CSSProperties
  }, [isIdle, layoutMode, mode, visibilityProfile])

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const rect = container.getBoundingClientRect()
    const width = Math.max(1, Math.floor(rect.width))
    const height = Math.max(1, Math.floor(rect.height))
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, MINI_MAX_DPR))

    const pixelWidth = Math.max(1, Math.floor(width * dpr))
    const pixelHeight = Math.max(1, Math.floor(height * dpr))

    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    canvas.width = pixelWidth
    canvas.height = pixelHeight

    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    canvasSizeRef.current = { width, height }
  }, [])

  useEffect(() => {
    resizeCanvas()

    const observer = new ResizeObserver(() => resizeCanvas())
    if (containerRef.current) observer.observe(containerRef.current)

    window.addEventListener('resize', resizeCanvas)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resizeCanvas)
    }
  }, [resizeCanvas])

  useEffect(() => {
    if (!isNativeAvailable()) return

    const unsubscribe = window.electronAPI.miniPlayer.onVisualizerChunk((chunk) => {
      sampleRateRef.current = Math.max(1, chunk.sampleRate)
      pitchLockRef.current = chunk.pitchLock
      const rawUnderfillEnabled = (chunk as { oscilloscopeUnderfillEnabled?: unknown }).oscilloscopeUnderfillEnabled
      oscilloscopeUnderfillEnabledRef.current = typeof rawUnderfillEnabled === 'boolean' ? rawUnderfillEnabled : false
      fftSizeRef.current = Math.max(1024, chunk.fftSize)
      lineColorRef.current = chunk.lineColor
      const activeMode = modeRef.current

      if (chunk.reset) {
        pendingLeftChunksRef.current = []
        pendingMonoChunksRef.current = []
        spectrumDataRef.current = null
        samplesReceivedRef.current = 0
        nativeOscilloscope.reset()
        nativeSpectrum.reset()
        return
      }

      // Only keep the queue needed by the active render mode.
      if (activeMode !== 'oscilloscope' && pendingLeftChunksRef.current.length > 0) {
        pendingLeftChunksRef.current = []
      }
      if (activeMode !== 'spectrum' && pendingMonoChunksRef.current.length > 0) {
        pendingMonoChunksRef.current = []
      }

      if (activeMode === 'oscilloscope' && chunk.leftChunks.length > 0) {
        pendingLeftChunksRef.current.push(...chunk.leftChunks)
        const overflow = pendingLeftChunksRef.current.length - MINI_MAX_PENDING_CHUNKS
        if (overflow > 0) {
          pendingLeftChunksRef.current = pendingLeftChunksRef.current.slice(-MINI_MAX_PENDING_CHUNKS)
        }
      }
      if (activeMode === 'spectrum' && chunk.monoChunks.length > 0) {
        pendingMonoChunksRef.current.push(...chunk.monoChunks)
        const overflow = pendingMonoChunksRef.current.length - MINI_MAX_PENDING_CHUNKS
        if (overflow > 0) {
          pendingMonoChunksRef.current = pendingMonoChunksRef.current.slice(-MINI_MAX_PENDING_CHUNKS)
        }
      }
    })

    return () => unsubscribe()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const ensureNativeConfig = () => {
      if (!isNativeAvailable()) return
      const sampleRate = sampleRateRef.current
      const fftSize = fftSizeRef.current
      const pitchLock = pitchLockRef.current

      if (configuredSampleRateRef.current !== sampleRate) {
        nativeOscilloscope.setSampleRate(sampleRate)
        nativeSpectrum.setSampleRate(sampleRate)
        nativeOscilloscope.setDisplaySamples(getNormalizedOscilloscopeDisplaySamples(sampleRate))
        configuredSampleRateRef.current = sampleRate
      }

      if (configuredPitchLockRef.current !== pitchLock) {
        nativeOscilloscope.setPitchLock(pitchLock)
        configuredPitchLockRef.current = pitchLock
      }

      if (configuredFftSizeRef.current !== fftSize) {
        nativeSpectrum.setFFTSize(fftSize)
        nativeSpectrum.setSmoothing(getNativeSpectrumSmoothing(fftSize))
        configuredFftSizeRef.current = fftSize
      }
    }

    const drawSpectrum = (
      width: number,
      height: number,
      accentColor: string,
      visualizerColor: string,
      idle: boolean,
      profile: VisibilityProfile
    ) => {
      const monoChunks = pendingMonoChunksRef.current
      pendingMonoChunksRef.current = []
      for (const chunk of monoChunks) {
        const result = nativeSpectrum.process(chunk)
        if (result && result.length > 0) {
          spectrumDataRef.current = result
        }
      }

      const frequencyData = spectrumDataRef.current
      if (!frequencyData || frequencyData.length === 0) return

      const binCount = frequencyData.length
      const sampleRate = sampleRateRef.current
      const nyquist = sampleRate / 2
      const binWidth = nyquist / binCount
      const maxDisplayFreq = Math.max(AMBIENT_SPECTRUM_MIN_FREQ + 1, Math.min(AMBIENT_SPECTRUM_MAX_FREQ, nyquist))
      const minTiltOffset = tiltOffsetAtFrequency(AMBIENT_SPECTRUM_MIN_FREQ)
      const maxTiltOffset = tiltOffsetAtFrequency(maxDisplayFreq)
      const minDb = SPECTRUM_MIN_DB + Math.min(minTiltOffset, maxTiltOffset)
      const maxDb = SPECTRUM_MAX_DB + Math.max(minTiltOffset, maxTiltOffset)
      const dbRange = Math.max(0.0001, maxDb - minDb)

      const isWideLayout = layoutModeRef.current === 'wide' || layoutModeRef.current === 'hero'
      const maxPointCount = isWideLayout
        ? MINI_WIDE_SPECTRUM_POINT_CAP
        : MINI_COMPACT_SPECTRUM_POINT_CAP
      const pointCount = Math.max(2, Math.min(Math.floor(width), maxPointCount))
      const points: Array<{ x: number; y: number }> = []

      for (let i = 0; i < pointCount; i++) {
        const x = pointCount > 1 ? (i / (pointCount - 1)) * width : 0
        const frequency = Math.max(
          AMBIENT_SPECTRUM_MIN_FREQ,
          frequencyAtX(x, width, AMBIENT_SPECTRUM_MIN_FREQ, maxDisplayFreq)
        )
        const bin = frequency / binWidth
        const low = Math.floor(bin)
        const high = Math.min(low + 1, binCount - 1)
        const frac = bin - low

        const dbLow = frequencyData[low] ?? minDb
        const dbHigh = frequencyData[high] ?? minDb
        const db = dbLow + (dbHigh - dbLow) * frac
        const tiltedDb = applyTilt(db, frequency)
        const clampedDb = Math.max(minDb, Math.min(maxDb, tiltedDb))
        const normalized = (clampedDb - minDb) / dbRange
        const shaped = Math.pow(Math.max(0, Math.min(1, normalized)), 0.86)
        const y = height - shaped * height
        points.push({ x, y })
      }

      if (points.length < 2) return

      const lineAlpha = clamp((idle ? 0.22 : 0.44) + (idle ? 0.13 : 0.24) * profile.visibilityBoost, 0, 0.78)
      const fillTopAlpha = clamp((idle ? 0.06 : 0.14) + (idle ? 0.05 : 0.10) * profile.visibilityBoost, 0, 0.38)
      const fillMidAlpha = clamp((idle ? 0.03 : 0.06) + (idle ? 0.04 : 0.08) * profile.visibilityBoost, 0, 0.26)
      const haloAlpha = clamp((idle ? 0.18 : 0.26) + (0.34 * profile.visibilityBoost), 0.16, 0.72)
      const haloWidth = 2.4 + (1.4 * profile.visibilityBoost)
      const lineWidth = 1.85 + (0.4 * profile.visibilityBoost)

      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y)
      }
      ctx.lineTo(width, height)
      ctx.lineTo(0, height)
      ctx.closePath()

      const gradient = ctx.createLinearGradient(0, height, 0, 0)
      gradient.addColorStop(0, colorWithAlpha(visualizerColor, 0, accentColor))
      gradient.addColorStop(0.45, colorWithAlpha(visualizerColor, fillMidAlpha, accentColor))
      gradient.addColorStop(1, colorWithAlpha(visualizerColor, fillTopAlpha, accentColor))
      ctx.fillStyle = gradient
      ctx.fill()

      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y)
      }
      ctx.strokeStyle = colorWithAlpha(profile.haloColor, haloAlpha, profile.haloColor)
      ctx.lineWidth = haloWidth
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y)
      }
      ctx.strokeStyle = colorWithAlpha(visualizerColor, lineAlpha, accentColor)
      ctx.lineWidth = lineWidth
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.stroke()
    }

    const drawOscilloscope = (
      width: number,
      height: number,
      accentColor: string,
      visualizerColor: string,
      idle: boolean,
      profile: VisibilityProfile
    ) => {
      const leftChunks = pendingLeftChunksRef.current
      pendingLeftChunksRef.current = []
      for (const chunk of leftChunks) {
        nativeOscilloscope.pushSamples(chunk)
        samplesReceivedRef.current += chunk.length
      }

      const pitchLock = pitchLockRef.current
      if (pitchLock && samplesReceivedRef.current < OSCILLOSCOPE_WARMUP_SAMPLES) return

      const result = nativeOscilloscope.processContinuous()
      if (!result) return

      const samplesToShow = result.samplesToShow
      let triggerIndex = result.triggerIndex

      if (!pitchLock) {
        const writePos = result.writePos
        triggerIndex = writePos - samplesToShow
        while (triggerIndex < 0) triggerIndex += OSCILLOSCOPE_BUFFER_SIZE
      }

      const renderData = nativeOscilloscope.getSamples(Math.floor(triggerIndex), samplesToShow)
      if (!renderData || renderData.length === 0) return

      const centerY = height / 2
      const baselineAccentAlpha = clamp((idle ? 0.18 : 0.28) + (idle ? 0.06 : 0.16) * profile.visibilityBoost, 0, 0.60)
      const baselineHaloAlpha = clamp((idle ? 0.14 : 0.22) + (0.26 * profile.visibilityBoost), 0.12, 0.56)
      const waveformAccentAlpha = clamp((idle ? 0.28 : 0.50) + (idle ? 0.10 : 0.22) * profile.visibilityBoost, 0, 0.82)
      const waveformHaloAlpha = clamp((idle ? 0.17 : 0.27) + (0.32 * profile.visibilityBoost), 0.14, 0.76)
      const underfillPeakAlpha = clamp((idle ? 0.12 : 0.24) + (idle ? 0.05 : 0.10) * profile.visibilityBoost, 0.12, 0.38)
      const underfillTintAmount = clamp((idle ? 0.12 : 0.18) + (0.08 * profile.visibilityBoost), 0.10, 0.30)
      const underfillEnabled = oscilloscopeUnderfillEnabledRef.current

      ctx.strokeStyle = colorWithAlpha(profile.haloColor, baselineHaloAlpha, profile.haloColor)
      ctx.lineWidth = 2.0 + (0.9 * profile.visibilityBoost)
      ctx.beginPath()
      ctx.moveTo(0, centerY)
      ctx.lineTo(width, centerY)
      ctx.stroke()

      ctx.strokeStyle = colorWithAlpha(visualizerColor, baselineAccentAlpha, accentColor)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, centerY)
      ctx.lineTo(width, centerY)
      ctx.stroke()

      const totalSamples = Math.min(samplesToShow, renderData.length)
      if (totalSamples < 2) return

      const stride = Math.max(1, Math.ceil(totalSamples / MINI_OSCILLOSCOPE_POINT_CAP))
      const visualGain = idle ? 1.35 : 1.8
      const points: Array<{ x: number; y: number }> = []
      let lastSampledIndex = -1
      for (let i = 0; i < totalSamples; i += stride) {
        const sample = renderData[i]
        const y = ((1 - sample * visualGain) / 2) * height
        const x = totalSamples > 1 ? (i / (totalSamples - 1)) * width : 0
        points.push({ x, y })
        lastSampledIndex = i
      }

      const lastIndex = totalSamples - 1
      if (lastSampledIndex !== lastIndex) {
        const sample = renderData[lastIndex]
        const y = ((1 - sample * visualGain) / 2) * height
        points.push({ x: width, y })
      }

      if (points.length < 2) return

      const shouldRenderUnderfill = underfillEnabled && points.length <= MINI_OSCILLOSCOPE_UNDERFILL_POINT_CAP
      if (shouldRenderUnderfill) {
        ctx.beginPath()
        ctx.moveTo(points[0].x, centerY)
        for (const point of points) {
          ctx.lineTo(point.x, point.y)
        }
        ctx.lineTo(points[points.length - 1].x, centerY)
        ctx.closePath()
        const underfillShoulderAlpha = clamp(underfillPeakAlpha * 0.72, 0.09, 0.32)
        const underfillCenterlineAlpha = clamp(underfillPeakAlpha * 0.30, 0.06, 0.14)
        const underfillGradient = ctx.createLinearGradient(0, 0, 0, height)
        underfillGradient.addColorStop(
          0,
          adaptiveMiniUnderfillColor(
            visualizerColor,
            profile.backdropLuminance,
            underfillTintAmount,
            underfillPeakAlpha
          )
        )
        underfillGradient.addColorStop(
          0.44,
          adaptiveMiniUnderfillColor(
            visualizerColor,
            profile.backdropLuminance,
            underfillTintAmount,
            underfillPeakAlpha * 0.94
          )
        )
        underfillGradient.addColorStop(
          0.48,
          adaptiveMiniUnderfillColor(
            visualizerColor,
            profile.backdropLuminance,
            underfillTintAmount,
            underfillShoulderAlpha
          )
        )
        underfillGradient.addColorStop(
          0.5,
          adaptiveMiniUnderfillColor(
            visualizerColor,
            profile.backdropLuminance,
            underfillTintAmount,
            underfillCenterlineAlpha
          )
        )
        underfillGradient.addColorStop(
          0.52,
          adaptiveMiniUnderfillColor(
            visualizerColor,
            profile.backdropLuminance,
            underfillTintAmount,
            underfillShoulderAlpha
          )
        )
        underfillGradient.addColorStop(
          0.56,
          adaptiveMiniUnderfillColor(
            visualizerColor,
            profile.backdropLuminance,
            underfillTintAmount,
            underfillPeakAlpha * 0.94
          )
        )
        underfillGradient.addColorStop(
          1,
          adaptiveMiniUnderfillColor(
            visualizerColor,
            profile.backdropLuminance,
            underfillTintAmount,
            underfillPeakAlpha
          )
        )
        ctx.fillStyle = underfillGradient
        ctx.fill()
      }

      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y)
      }
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = colorWithAlpha(profile.haloColor, waveformHaloAlpha, profile.haloColor)
      ctx.lineWidth = 2.4 + (1.3 * profile.visibilityBoost)
      ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y)
      }
      ctx.strokeStyle = colorWithAlpha(visualizerColor, waveformAccentAlpha, accentColor)
      ctx.lineWidth = 1.6 + (0.4 * profile.visibilityBoost)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.stroke()
    }

    const draw = () => {
      const { width, height } = canvasSizeRef.current
      if (!isNativeAvailable() || width <= 0 || height <= 0) {
        animationRef.current = window.requestAnimationFrame(draw)
        return
      }

      const currentMode = modeRef.current
      if (currentMode === 'off') {
        animationRef.current = window.requestAnimationFrame(draw)
        return
      }

      ctx.clearRect(0, 0, width, height)

      ensureNativeConfig()

      const visualizerColor = lineColorRef.current
      const accentColor = visualizerColor
      const idle = idleRef.current
      const profile = visibilityProfileRef.current

      if (currentMode === 'spectrum') {
        drawSpectrum(width, height, accentColor, visualizerColor, idle, profile)
      } else {
        drawOscilloscope(width, height, accentColor, visualizerColor, idle, profile)
      }

      animationRef.current = window.requestAnimationFrame(draw)
    }

    animationRef.current = window.requestAnimationFrame(draw)
    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current)
        animationRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    return () => {
      if (isNativeAvailable()) {
        nativeOscilloscope.reset()
        nativeSpectrum.reset()
      }
      pendingLeftChunksRef.current = []
      pendingMonoChunksRef.current = []
      spectrumDataRef.current = null
      samplesReceivedRef.current = 0
      configuredSampleRateRef.current = 0
      configuredFftSizeRef.current = 0
      configuredPitchLockRef.current = null
      oscilloscopeUnderfillEnabledRef.current = false
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className={`mini-player-backdrop-visualizer ${isIdle ? 'is-idle' : ''}`.trim()}
      data-mode={mode}
      style={visualizerStyle}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="mini-player-backdrop-visualizer-canvas" />
    </div>
  )
}
