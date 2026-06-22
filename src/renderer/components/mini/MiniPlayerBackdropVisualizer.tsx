import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { MiniPlayerLayoutMode, MiniPlayerVisualizerMode } from '../../../types/miniPlayer'
import {
  AMBIENT_SPECTRUM_MAX_FREQ,
  AMBIENT_SPECTRUM_MIN_FREQ,
  applyTilt,
  clamp,
  colorWithAlpha,
  frequencyAtX,
  lerp,
  relativeLuminance,
  saturationFromRgb,
  tiltOffsetAtFrequency
} from '../visualizers/ambientSpectrumMath'
import {
  isNativeAvailable,
  oscilloscope as nativeOscilloscope,
  OSCILLOSCOPE_BUFFER_SIZE,
  spectrum as nativeSpectrum
} from '../../audio/native/index'
import { getNormalizedOscilloscopeDisplaySamples } from '../../audio/native/oscilloscopeDisplaySamples'
import {
  deriveFallbackBackdropMetrics,
  resolveMiniBackdropRenderProfile,
  type BackdropMetrics,
  type MiniBackdropResolvedProfile
} from './miniPlayerBackdropContrast.ts'
import { useBufferedCanvasResize } from '../../hooks/useBufferedCanvasResize'

interface MiniPlayerBackdropVisualizerProps {
  mode: MiniPlayerVisualizerMode
  lineColor: string
  isIdle: boolean
  artworkDataUrl: string | null
  layoutMode: MiniPlayerLayoutMode
}

const OSCILLOSCOPE_WARMUP_SAMPLES = 4096
const SPECTRUM_MIN_DB = -90
const SPECTRUM_MAX_DB = -10
const SPECTRUM_SMOOTHING_BASE = 0.9
const ARTWORK_SAMPLE_SIZE = 28
const ARTWORK_MIN_ALPHA = 24
const MINI_MAX_PENDING_CHUNKS = 24
const MINI_COMPACT_SPECTRUM_POINT_CAP = 320
const MINI_WIDE_SPECTRUM_POINT_CAP = 520
const MINI_OSCILLOSCOPE_POINT_CAP = 1024
const MINI_OSCILLOSCOPE_UNDERFILL_POINT_CAP = 640

interface WeightedLuminanceSample {
  luminance: number
  weight: number
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

function weightedPercentile(
  samples: WeightedLuminanceSample[],
  totalWeight: number,
  percentile: number
): number {
  if (samples.length === 0 || totalWeight <= 0) return 0

  const target = clamp(percentile, 0, 1) * totalWeight
  let cumulative = 0
  for (const sample of samples) {
    cumulative += sample.weight
    if (cumulative >= target) {
      return sample.luminance
    }
  }

  return samples[samples.length - 1]?.luminance ?? 0
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
    const luminanceSamples: WeightedLuminanceSample[] = []

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3]
      if (alpha < ARTWORK_MIN_ALPHA) continue

      const weight = alpha / 255
      if (weight <= 0) continue

      const rgb = { r: data[i], g: data[i + 1], b: data[i + 2] }
      const luminance = relativeLuminance(rgb)
      luminanceSum += luminance * weight
      saturationSum += saturationFromRgb(rgb) * weight
      totalWeight += weight
      luminanceSamples.push({ luminance, weight })
    }

    if (totalWeight <= 0) return null

    luminanceSamples.sort((left, right) => left.luminance - right.luminance)

    return {
      luminanceMean: clamp(luminanceSum / totalWeight, 0, 1),
      saturationMean: clamp(saturationSum / totalWeight, 0, 1),
      luminanceP20: clamp(weightedPercentile(luminanceSamples, totalWeight, 0.2), 0, 1),
      luminanceP80: clamp(weightedPercentile(luminanceSamples, totalWeight, 0.8), 0, 1)
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

function resolveOpacity(
  mode: MiniPlayerVisualizerMode,
  layoutMode: MiniPlayerLayoutMode,
  idle: boolean,
  profile: MiniBackdropResolvedProfile
): number {
  if (mode === 'off') return 0

  const isCompactLayout = layoutMode === 'strip'
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
  const drawRef = useRef<(() => void) | null>(null)
  const [isReducedMotion, setIsReducedMotion] = useState(false)
  const renderMode: MiniPlayerVisualizerMode = isReducedMotion ? 'off' : mode
  const modeRef = useRef(renderMode)
  const layoutModeRef = useRef(layoutMode)
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
  const renderProfileRef = useRef<MiniBackdropResolvedProfile>(
    resolveMiniBackdropRenderProfile(lineColor, deriveFallbackBackdropMetrics(lineColor))
  )
  const [sampledBackdropMetrics, setSampledBackdropMetrics] = useState<BackdropMetrics | null>(null)
  const { sizeRef: canvasSizeRef } = useBufferedCanvasResize(containerRef, canvasRef, {
    scaleContextToDpr: true,
    deferBackingStoreResizeMs: 96,
  })

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setIsReducedMotion(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    layoutModeRef.current = layoutMode
  }, [layoutMode])

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

  const renderProfile = useMemo(
    () => resolveMiniBackdropRenderProfile(lineColor, activeBackdropMetrics),
    [lineColor, activeBackdropMetrics]
  )

  useEffect(() => {
    renderProfileRef.current = renderProfile
  }, [renderProfile])

  const visualizerStyle = useMemo(() => {
    const opacity = resolveOpacity(renderMode, layoutMode, isIdle, renderProfile)
    return {
      '--mini-visualizer-opacity': opacity.toFixed(3),
      '--mini-visualizer-blend': renderProfile.blendMode,
    } as CSSProperties
  }, [isIdle, layoutMode, renderMode, renderProfile])

  const stopAnimationLoop = useCallback(() => {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current)
      animationRef.current = null
    }
  }, [])

  const scheduleNextFrame = useCallback(() => {
    if (modeRef.current === 'off' || animationRef.current !== null) {
      return
    }

    animationRef.current = window.requestAnimationFrame(() => {
      animationRef.current = null
      drawRef.current?.()
    })
  }, [])

  useEffect(() => {
    modeRef.current = renderMode
    if (renderMode === 'off') {
      pendingLeftChunksRef.current = []
      pendingMonoChunksRef.current = []
      spectrumDataRef.current = null
      samplesReceivedRef.current = 0
      if (isNativeAvailable()) {
        nativeOscilloscope.reset()
        nativeSpectrum.reset()
      }
      stopAnimationLoop()
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      const { width, height } = canvasSizeRef.current
      if (ctx && width > 0 && height > 0) {
        ctx.clearRect(0, 0, width, height)
      }
      return
    }

    scheduleNextFrame()
  }, [renderMode, scheduleNextFrame, stopAnimationLoop])

  useEffect(() => {
    if (!isNativeAvailable()) return

    const unsubscribe = window.electronAPI.miniPlayer.onVisualizerChunk((chunk) => {
      sampleRateRef.current = Math.max(1, chunk.sampleRate)
      pitchLockRef.current = chunk.pitchLock
      const rawUnderfillEnabled = (chunk as { oscilloscopeUnderfillEnabled?: unknown }).oscilloscopeUnderfillEnabled
      oscilloscopeUnderfillEnabledRef.current = typeof rawUnderfillEnabled === 'boolean' ? rawUnderfillEnabled : false
      fftSizeRef.current = Math.max(1024, chunk.fftSize)
      const activeMode = modeRef.current

      if (chunk.reset) {
        pendingLeftChunksRef.current = []
        pendingMonoChunksRef.current = []
        spectrumDataRef.current = null
        samplesReceivedRef.current = 0
        nativeOscilloscope.reset()
        nativeSpectrum.reset()
        if (activeMode !== 'off') {
          scheduleNextFrame()
        }
        return
      }

      if (activeMode === 'off') {
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

      scheduleNextFrame()
    })

    return () => unsubscribe()
  }, [scheduleNextFrame])

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
      idle: boolean,
      profile: MiniBackdropResolvedProfile
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

      const isWideLayout = layoutModeRef.current === 'card' || layoutModeRef.current === 'cover'
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

      const lineAlpha = clamp(
        (idle ? 0.22 : 0.44) +
        ((idle ? 0.13 : 0.24) * profile.visibilityBoost) +
        ((idle ? 0.04 : 0.08) * profile.neutralMix),
        0,
        0.84
      )
      const fillTopAlpha = clamp(
        (idle ? 0.06 : 0.14) +
        ((idle ? 0.05 : 0.10) * profile.visibilityBoost) +
        (0.04 * profile.neutralMix),
        0,
        0.42
      )
      const fillMidAlpha = clamp(
        (idle ? 0.03 : 0.06) +
        ((idle ? 0.04 : 0.08) * profile.visibilityBoost) +
        (0.03 * profile.neutralMix),
        0,
        0.30
      )
      const haloAlpha = clamp(
        (idle ? 0.18 : 0.26) +
        (0.26 * profile.visibilityBoost) +
        (0.22 * profile.neutralMix),
        0.16,
        0.82
      )
      const haloWidth = 2.4 + (1.0 * profile.visibilityBoost) + (1.0 * profile.neutralMix)
      const lineWidth = 1.85 + (0.28 * profile.visibilityBoost) + (0.22 * profile.neutralMix)

      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y)
      }
      ctx.lineTo(width, height)
      ctx.lineTo(0, height)
      ctx.closePath()

      const gradient = ctx.createLinearGradient(0, height, 0, 0)
      gradient.addColorStop(0, colorWithAlpha(profile.fillColor, 0, profile.fillColor))
      gradient.addColorStop(0.45, colorWithAlpha(profile.fillColor, fillMidAlpha, profile.fillColor))
      gradient.addColorStop(1, colorWithAlpha(profile.fillColor, fillTopAlpha, profile.fillColor))
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
      ctx.strokeStyle = colorWithAlpha(profile.strokeColor, lineAlpha, profile.strokeColor)
      ctx.lineWidth = lineWidth
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.stroke()
    }

    const drawOscilloscope = (
      width: number,
      height: number,
      idle: boolean,
      profile: MiniBackdropResolvedProfile
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
      const waveformAccentAlpha = clamp(
        (idle ? 0.28 : 0.50) +
        ((idle ? 0.10 : 0.22) * profile.visibilityBoost) +
        ((idle ? 0.05 : 0.10) * profile.neutralMix),
        0,
        0.86
      )
      const waveformHaloAlpha = clamp(
        (idle ? 0.17 : 0.27) +
        (0.24 * profile.visibilityBoost) +
        (0.22 * profile.neutralMix),
        0.14,
        0.82
      )
      const underfillPeakAlpha = clamp(
        (idle ? 0.12 : 0.24) +
        ((idle ? 0.05 : 0.10) * profile.visibilityBoost) +
        (0.06 * profile.neutralMix),
        0.12,
        0.42
      )
      const underfillEnabled = oscilloscopeUnderfillEnabledRef.current

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
        underfillGradient.addColorStop(0, colorWithAlpha(profile.fillColor, underfillPeakAlpha, profile.fillColor))
        underfillGradient.addColorStop(0.44, colorWithAlpha(profile.fillColor, underfillPeakAlpha * 0.94, profile.fillColor))
        underfillGradient.addColorStop(0.48, colorWithAlpha(profile.fillColor, underfillShoulderAlpha, profile.fillColor))
        underfillGradient.addColorStop(0.5, colorWithAlpha(profile.fillColor, underfillCenterlineAlpha, profile.fillColor))
        underfillGradient.addColorStop(0.52, colorWithAlpha(profile.fillColor, underfillShoulderAlpha, profile.fillColor))
        underfillGradient.addColorStop(0.56, colorWithAlpha(profile.fillColor, underfillPeakAlpha * 0.94, profile.fillColor))
        underfillGradient.addColorStop(1, colorWithAlpha(profile.fillColor, underfillPeakAlpha, profile.fillColor))
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
      ctx.lineWidth = 2.4 + (0.9 * profile.visibilityBoost) + (0.9 * profile.neutralMix)
      ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y)
      }
      ctx.strokeStyle = colorWithAlpha(profile.strokeColor, waveformAccentAlpha, profile.strokeColor)
      ctx.lineWidth = 1.6 + (0.28 * profile.visibilityBoost) + (0.24 * profile.neutralMix)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.stroke()
    }

    drawRef.current = () => {
      const { width, height } = canvasSizeRef.current
      if (width <= 0 || height <= 0) {
        scheduleNextFrame()
        return
      }
      if (!isNativeAvailable()) {
        ctx.clearRect(0, 0, width, height)
        return
      }

      const currentMode = modeRef.current
      if (currentMode === 'off') {
        return
      }

      ctx.clearRect(0, 0, width, height)

      ensureNativeConfig()

      const idle = idleRef.current
      const profile = renderProfileRef.current

      if (currentMode === 'spectrum') {
        drawSpectrum(width, height, idle, profile)
      } else {
        drawOscilloscope(width, height, idle, profile)
      }

      scheduleNextFrame()
    }

    scheduleNextFrame()
    return () => {
      drawRef.current = null
      stopAnimationLoop()
    }
  }, [scheduleNextFrame, stopAnimationLoop])

  useEffect(() => {
    return () => {
      stopAnimationLoop()
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
  }, [stopAnimationLoop])

  return (
    <div
      ref={containerRef}
      className={`mini-player-backdrop-visualizer ${isIdle ? 'is-idle' : ''}`.trim()}
      data-mode={renderMode}
      style={visualizerStyle}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="mini-player-backdrop-visualizer-canvas" />
    </div>
  )
}
