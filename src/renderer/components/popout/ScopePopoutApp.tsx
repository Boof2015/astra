import { useCallback, useEffect, useMemo, useRef, type MutableRefObject, type RefObject } from 'react'
import {
  isNativeAvailable,
  oscilloscope as nativeOscilloscope,
  OSCILLOSCOPE_BUFFER_SIZE,
  vectorscope as nativeVectorscope
} from '../../audio/native'
import { SpectrumAnalyzer, Spectrogram, VUMeter } from '../../audio/visualizers'
import { getNormalizedOscilloscopeDisplaySamples } from '../../audio/native/oscilloscopeDisplaySamples'
import {
  isScopeKind,
  type ScopeKind,
} from '../../../types/scopePopout'
import {
  DEFAULT_SPECTROGRAM_CLARITY_MODE,
  DEFAULT_SPECTROGRAM_SCALE_MODE,
  DEFAULT_SPECTROGRAM_SCROLL_SPEED,
  clampSpectrogramScrollSpeed,
  isSpectrogramClarityMode,
  isSpectrogramScaleMode,
} from '../../../types/spectrogram'
import { DEFAULT_VU_METER_MODE, isVUMeterMode, type VUMeterMode } from '../../../types/vumeter'
import { isVectorscopeMode, type VectorscopeMode } from '../../stores/visualizerSettingsStore'
import { transformPoint, drawVectorscopeGridForMode, getVectorscopeLayout } from '../../audio/visualizers/vectorscopeGrids'
import { MultibandSplitter, MultibandBuffer, BAND_COLORS } from '../../audio/visualizers/multibandSplitter'
import '../../styles/scope-popout.css'

const OSCILLOSCOPE_WARMUP_SAMPLES = 4096
const DEFAULT_SPECTRUM_LINE_COLOR = '#38bdf8'
const DEFAULT_SPECTRUM_FFT_SIZE = 4096

function parseRgbChannels(color: string): string | null {
  const normalized = color.trim()

  if (normalized.startsWith('#')) {
    const hex = normalized.slice(1)
    const expanded = hex.length === 3
      ? hex.split('').map((ch) => `${ch}${ch}`).join('')
      : hex

    if (expanded.length === 6) {
      const r = Number.parseInt(expanded.slice(0, 2), 16)
      const g = Number.parseInt(expanded.slice(2, 4), 16)
      const b = Number.parseInt(expanded.slice(4, 6), 16)
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        return `${r}, ${g}, ${b}`
      }
    }
  }

  const rgbMatch = /^rgba?\((.*)\)$/i.exec(normalized)
  if (!rgbMatch) return null

  const tokens = rgbMatch[1]
    ?.split(',')
    .map((token) => token.trim())
    .filter(Boolean) ?? []
  if (tokens.length < 3) return null

  const r = Number.parseFloat(tokens[0])
  const g = Number.parseFloat(tokens[1])
  const b = Number.parseFloat(tokens[2])
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null

  return `${Math.max(0, Math.min(255, Math.round(r)))}, ${Math.max(0, Math.min(255, Math.round(g)))}, ${Math.max(0, Math.min(255, Math.round(b)))}`
}

function highContrastUnderfillColor(accentColor: string, alpha: number): string {
  const safeAlpha = Math.max(0, Math.min(1, alpha))
  const channels = parseRgbChannels(accentColor)
  const nearWhite = { r: 245, g: 248, b: 252 }
  const tintAmount = 0.18

  if (!channels) {
    return `rgba(${nearWhite.r}, ${nearWhite.g}, ${nearWhite.b}, ${safeAlpha})`
  }

  const [accentR, accentG, accentB] = channels
    .split(',')
    .map((token) => Number.parseFloat(token.trim()))

  if (!Number.isFinite(accentR) || !Number.isFinite(accentG) || !Number.isFinite(accentB)) {
    return `rgba(${nearWhite.r}, ${nearWhite.g}, ${nearWhite.b}, ${safeAlpha})`
  }

  const mix = (base: number, tint: number): number => Math.round((base * (1 - tintAmount)) + (tint * tintAmount))
  const r = mix(nearWhite.r, accentR)
  const g = mix(nearWhite.g, accentG)
  const b = mix(nearWhite.b, accentB)
  return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`
}

function getScopeLabel(scope: ScopeKind): string {
  switch (scope) {
    case 'spectrum':
      return 'Spectrum'
    case 'oscilloscope':
      return 'Oscilloscope'
    case 'vectorscope':
      return 'Vectorscope'
    case 'spectrogram':
      return 'Spectrogram'
    case 'vumeter':
      return 'VU Meter'
  }
}

function drawUnavailableMessage(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.62)'
  ctx.font = '12px "JetBrains Mono", monospace'
  ctx.textAlign = 'center'
  ctx.fillText('Native visualizer module unavailable', width / 2, height / 2)
}

function drawScopeGrid(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
  ctx.lineWidth = 1

  ctx.beginPath()
  ctx.moveTo(0, height / 2)
  ctx.lineTo(width, height / 2)
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(width / 2, 0)
  ctx.lineTo(width / 2, height)
  ctx.stroke()
}

function getSpectrumGradientColors(lineColor: string): string[] {
  return ['rgba(0, 255, 255, 0)', `${lineColor}33`, `${lineColor}66`]
}

function resizeCanvasToContainer(canvas: HTMLCanvasElement, container: HTMLDivElement): void {
  const rect = container.getBoundingClientRect()
  const width = Math.max(1, Math.floor(rect.width))
  const height = Math.max(1, Math.floor(rect.height))
  const dpr = window.devicePixelRatio || 1

  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  canvas.width = Math.max(1, Math.floor(width * dpr))
  canvas.height = Math.max(1, Math.floor(height * dpr))
}

function useHiDpiCanvasSize(
  containerRef: RefObject<HTMLDivElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>
): MutableRefObject<{ width: number; height: number }> {
  const sizeRef = useRef({ width: 0, height: 0 })

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const rect = container.getBoundingClientRect()
    const width = Math.max(1, Math.floor(rect.width))
    const height = Math.max(1, Math.floor(rect.height))
    const dpr = window.devicePixelRatio || 1

    canvas.width = Math.max(1, Math.floor(width * dpr))
    canvas.height = Math.max(1, Math.floor(height * dpr))

    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    sizeRef.current = { width, height }
  }, [canvasRef, containerRef])

  useEffect(() => {
    resizeCanvas()
    const observer = new ResizeObserver(() => resizeCanvas())
    const container = containerRef.current
    if (container) {
      observer.observe(container)
    }

    window.addEventListener('resize', resizeCanvas)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resizeCanvas)
    }
  }, [containerRef, resizeCanvas])

  return sizeRef
}

function SpectrumScopeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<SpectrumAnalyzer | null>(null)

  const pendingChunksRef = useRef<Float32Array[]>([])
  const sampleRateRef = useRef(48000)
  const fftSizeRef = useRef(DEFAULT_SPECTRUM_FFT_SIZE)
  const lineColorRef = useRef(DEFAULT_SPECTRUM_LINE_COLOR)
  const isPlayingRef = useRef(false)

  const handleResize = useCallback(() => {
    if (!canvasRef.current || !containerRef.current) return
    resizeCanvasToContainer(canvasRef.current, containerRef.current)
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI.scopePopout.onChunk((chunk) => {
      if (chunk.scope !== 'spectrum') return
      sampleRateRef.current = Math.max(1, chunk.sampleRate)
      const nextFftSize = Math.max(1024, chunk.fftSize)
      const nextLineColor = chunk.lineColor
      const optionsChanged =
        nextFftSize !== fftSizeRef.current ||
        nextLineColor !== lineColorRef.current

      fftSizeRef.current = nextFftSize
      lineColorRef.current = nextLineColor

      if (chunk.reset) {
        pendingChunksRef.current = []
        isPlayingRef.current = false
      } else if (chunk.monoChunks.length > 0) {
        pendingChunksRef.current.push(...chunk.monoChunks)
        isPlayingRef.current = true
      }

      if (optionsChanged) {
        visualizerRef.current?.setOptions({
          lineColor: nextLineColor,
          fftSize: nextFftSize,
          gradientColors: getSpectrumGradientColors(nextLineColor),
        })
      }
    })

    return () => unsubscribe()
  }, [])

  useEffect(() => {
    handleResize()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new SpectrumAnalyzer(canvasRef.current, {
        lineColor: lineColorRef.current,
        lineWidth: 2,
        fillGradient: true,
        fftSize: fftSizeRef.current,
        gradientColors: getSpectrumGradientColors(lineColorRef.current),
        scaleType: 'log',
        showGrid: true,
        dataSource: {
          getPendingSpectrumSamples: () => {
            const pendingChunks = pendingChunksRef.current
            pendingChunksRef.current = []
            return pendingChunks
          },
          getSampleRate: () => sampleRateRef.current,
          isPlaying: () => isPlayingRef.current,
        },
      })
    }

    visualizerRef.current?.start()

    return () => {
      visualizerRef.current?.dispose()
      visualizerRef.current = null
      pendingChunksRef.current = []
      isPlayingRef.current = false
    }
  }, [handleResize])

  useEffect(() => {
    handleResize()

    const observer = new ResizeObserver(() => {
      handleResize()
    })
    if (containerRef.current) observer.observe(containerRef.current)

    window.addEventListener('resize', handleResize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [handleResize])

  return (
    <div ref={containerRef} className="scope-popout-canvas-wrap">
      <canvas ref={canvasRef} className="scope-popout-canvas" />
    </div>
  )
}

function OscilloscopeScopeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const canvasSizeRef = useHiDpiCanvasSize(containerRef, canvasRef)
  const animationRef = useRef<number | null>(null)

  const pendingChunksRef = useRef<Float32Array[]>([])
  const sampleRateRef = useRef(48000)
  const pitchLockRef = useRef(true)
  const underfillEnabledRef = useRef(false)
  const lineColorRef = useRef('#38bdf8')
  const samplesReceivedRef = useRef(0)
  const configuredSampleRateRef = useRef(0)
  const configuredPitchLockRef = useRef<boolean | null>(null)

  useEffect(() => {
    const unsubscribe = window.electronAPI.scopePopout.onChunk((chunk) => {
      if (chunk.scope !== 'oscilloscope') return
      sampleRateRef.current = Math.max(1, chunk.sampleRate)
      pitchLockRef.current = chunk.pitchLock
      const rawUnderfillEnabled = (chunk as { oscilloscopeUnderfillEnabled?: unknown }).oscilloscopeUnderfillEnabled
      underfillEnabledRef.current = typeof rawUnderfillEnabled === 'boolean' ? rawUnderfillEnabled : false
      lineColorRef.current = chunk.lineColor

      if (chunk.reset) {
        pendingChunksRef.current = []
        samplesReceivedRef.current = 0
        if (isNativeAvailable()) {
          nativeOscilloscope.reset()
        }
        return
      }

      if (chunk.leftChunks.length > 0) {
        pendingChunksRef.current.push(...chunk.leftChunks)
      }
    })

    return () => unsubscribe()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const draw = () => {
      const { width, height } = canvasSizeRef.current
      ctx.clearRect(0, 0, width, height)
      drawScopeGrid(ctx, width, height)

      if (!isNativeAvailable()) {
        drawUnavailableMessage(ctx, width, height)
        animationRef.current = window.requestAnimationFrame(draw)
        return
      }

      const sampleRate = sampleRateRef.current
      const pitchLock = pitchLockRef.current

      if (configuredSampleRateRef.current !== sampleRate) {
        nativeOscilloscope.setSampleRate(sampleRate)
        const displaySamples = getNormalizedOscilloscopeDisplaySamples(sampleRate)
        nativeOscilloscope.setDisplaySamples(displaySamples)
        configuredSampleRateRef.current = sampleRate
      }
      if (configuredPitchLockRef.current !== pitchLock) {
        nativeOscilloscope.setPitchLock(pitchLock)
        configuredPitchLockRef.current = pitchLock
      }

      const pendingChunks = pendingChunksRef.current
      pendingChunksRef.current = []
      for (const chunk of pendingChunks) {
        nativeOscilloscope.pushSamples(chunk)
        samplesReceivedRef.current += chunk.length
      }

      if (pitchLock && samplesReceivedRef.current < OSCILLOSCOPE_WARMUP_SAMPLES) {
        animationRef.current = window.requestAnimationFrame(draw)
        return
      }

      const result = nativeOscilloscope.processContinuous()
      if (!result || result.samplesToShow <= 0) {
        animationRef.current = window.requestAnimationFrame(draw)
        return
      }

      let triggerIndex = result.triggerIndex
      if (!pitchLock) {
        triggerIndex = result.writePos - result.samplesToShow
        while (triggerIndex < 0) {
          triggerIndex += OSCILLOSCOPE_BUFFER_SIZE
        }
      }

      const renderData = nativeOscilloscope.getSamples(Math.floor(triggerIndex), result.samplesToShow)
      if (!renderData || renderData.length === 0) {
        animationRef.current = window.requestAnimationFrame(draw)
        return
      }

      const lineColor = lineColorRef.current
      const underfillEnabled = underfillEnabledRef.current
      const sliceWidth = width / result.samplesToShow
      const centerY = height / 2
      const points: Array<{ x: number; y: number }> = []
      for (let i = 0; i < result.samplesToShow && i < renderData.length; i++) {
        const x = i * sliceWidth
        const y = ((1 - renderData[i] * 1.8) / 2) * height
        points.push({ x, y })
      }

      if (points.length < 2) {
        animationRef.current = window.requestAnimationFrame(draw)
        return
      }

      if (underfillEnabled) {
        ctx.beginPath()
        ctx.moveTo(points[0].x, centerY)
        for (const point of points) {
          ctx.lineTo(point.x, point.y)
        }
        ctx.lineTo(points[points.length - 1].x, centerY)
        ctx.closePath()
        const peakAlpha = 0.26
        const shoulderAlpha = peakAlpha * 0.74
        const centerlineAlpha = 0.08
        const fillGradient = ctx.createLinearGradient(0, 0, 0, height)
        fillGradient.addColorStop(0, highContrastUnderfillColor(lineColor, peakAlpha))
        fillGradient.addColorStop(0.44, highContrastUnderfillColor(lineColor, peakAlpha * 0.94))
        fillGradient.addColorStop(0.48, highContrastUnderfillColor(lineColor, shoulderAlpha))
        fillGradient.addColorStop(0.5, highContrastUnderfillColor(lineColor, centerlineAlpha))
        fillGradient.addColorStop(0.52, highContrastUnderfillColor(lineColor, shoulderAlpha))
        fillGradient.addColorStop(0.56, highContrastUnderfillColor(lineColor, peakAlpha * 0.94))
        fillGradient.addColorStop(1, highContrastUnderfillColor(lineColor, peakAlpha))
        ctx.fillStyle = fillGradient
        ctx.fill()
      }

      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y)
      }
      ctx.lineWidth = 1.8
      ctx.strokeStyle = lineColor
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.stroke()

      animationRef.current = window.requestAnimationFrame(draw)
    }

    animationRef.current = window.requestAnimationFrame(draw)

    return () => {
      if (animationRef.current !== null) {
        window.cancelAnimationFrame(animationRef.current)
        animationRef.current = null
      }
      if (isNativeAvailable()) {
        nativeOscilloscope.reset()
      }
      pendingChunksRef.current = []
      samplesReceivedRef.current = 0
      configuredSampleRateRef.current = 0
      configuredPitchLockRef.current = null
      underfillEnabledRef.current = false
    }
  }, [canvasSizeRef])

  return (
    <div ref={containerRef} className="scope-popout-canvas-wrap">
      <canvas ref={canvasRef} className="scope-popout-canvas" />
    </div>
  )
}

function VectorscopeScopeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const canvasSizeRef = useHiDpiCanvasSize(containerRef, canvasRef)
  const animationRef = useRef<number | null>(null)

  const pendingChunksRef = useRef<Array<{ left: Float32Array; right: Float32Array }>>([])
  const sampleRateRef = useRef(48000)
  const lineColorRef = useRef('#38bdf8')
  const vectorscopeModeRef = useRef<VectorscopeMode>('lissajous')
  const vectorscopeMultibandRef = useRef(false)
  const configuredSampleRateRef = useRef(0)
  const splitterRef = useRef<MultibandSplitter>(new MultibandSplitter())
  const multibandBufferRef = useRef<MultibandBuffer>(new MultibandBuffer())

  useEffect(() => {
    const unsubscribe = window.electronAPI.scopePopout.onChunk((chunk) => {
      if (chunk.scope !== 'vectorscope') return
      sampleRateRef.current = Math.max(1, chunk.sampleRate)
      lineColorRef.current = chunk.lineColor

      if ('vectorscopeMode' in chunk && isVectorscopeMode(chunk.vectorscopeMode)) {
        vectorscopeModeRef.current = chunk.vectorscopeMode
      }
      if ('vectorscopeMultiband' in chunk) {
        vectorscopeMultibandRef.current = Boolean(chunk.vectorscopeMultiband)
      }

      if (chunk.reset) {
        pendingChunksRef.current = []
        if (isNativeAvailable()) {
          nativeVectorscope.reset()
        }
        splitterRef.current.reset()
        multibandBufferRef.current.reset()
        return
      }

      if (chunk.stereoChunks.length > 0) {
        pendingChunksRef.current.push(...chunk.stereoChunks)
      }
    })

    return () => unsubscribe()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const draw = () => {
      const { width, height } = canvasSizeRef.current

      ctx.clearRect(0, 0, width, height)

      const mode = vectorscopeModeRef.current
      const isPolar = mode === 'polar-unipolar' || mode === 'polar-bipolar'
      const visualGain = isPolar ? 1.2 : 1.5
      const layout = getVectorscopeLayout(width, height, mode)
      const centerX = layout.centerX
      const centerY = layout.centerY
      const scale = layout.radius * visualGain

      drawVectorscopeGridForMode(ctx, width, height, 'rgba(255, 255, 255, 0.08)', mode)

      const lineColor = lineColorRef.current
      const multiband = vectorscopeMultibandRef.current
      const sampleRate = sampleRateRef.current

      // Configure native sample rate
      if (isNativeAvailable() && configuredSampleRateRef.current !== sampleRate) {
        nativeVectorscope.setSampleRate(sampleRate)
        configuredSampleRateRef.current = sampleRate
      }

      const pendingChunks = pendingChunksRef.current
      pendingChunksRef.current = []

      if (multiband) {
        // Multiband path: split into 3 bands, buffer, draw all with age-based opacity
        if (sampleRate > 0) {
          splitterRef.current.configure(sampleRate)
        }

        // Also push to native so switching back is seamless
        if (isNativeAvailable()) {
          for (const chunk of pendingChunks) {
            nativeVectorscope.pushSamples(chunk.left, chunk.right)
          }
        }

        // Split and accumulate into circular buffer
        for (const chunk of pendingChunks) {
          const bands = splitterRef.current.split(chunk.left, chunk.right)
          multibandBufferRef.current.push(bands)
        }

        // Draw all buffered points with age-based opacity
        const result = multibandBufferRef.current.getPoints(4096)
        if (result.count > 0) {
          const bandOrder = ['low', 'mid', 'high'] as const
          const segments = 8
          const pointsPerSegment = Math.ceil(result.count / segments)

          for (let seg = 0; seg < segments; seg++) {
            const start = seg * pointsPerSegment
            const end = Math.min((seg + 1) * pointsPerSegment, result.count)
            if (start >= result.count) break

            ctx.globalAlpha = 0.16 + 0.84 * (seg / Math.max(1, segments - 1))

            for (const band of bandOrder) {
              const bandData = result.bands[band]
              ctx.fillStyle = BAND_COLORS[band]

              for (let i = start; i < end; i++) {
                const point = transformPoint(bandData.left[i], bandData.right[i], mode)
                if (!point) continue

                const px = centerX + point.dx * scale
                const py = centerY - point.dy * scale
                ctx.fillRect(px - 1, py - 1, 2, 2)
              }
            }
          }
          ctx.globalAlpha = 1
        }
      } else if (isNativeAvailable()) {
        for (const chunk of pendingChunks) {
          nativeVectorscope.pushSamples(chunk.left, chunk.right)
        }

        const points = nativeVectorscope.getPoints(4096)
        if (points && points.count > 0) {
          const segments = 8
          const pointsPerSegment = Math.ceil(points.count / segments)

          for (let segment = 0; segment < segments; segment++) {
            const start = segment * pointsPerSegment
            const end = Math.min(points.count, (segment + 1) * pointsPerSegment)
            if (start >= points.count) break

            ctx.fillStyle = lineColor
            ctx.globalAlpha = 0.16 + 0.84 * (segment / Math.max(1, segments - 1))

            for (let i = start; i < end; i++) {
              // Native returns x=Right, y=Left
              const point = transformPoint(points.y[i], points.x[i], mode)
              if (!point) continue

              const px = centerX + point.dx * scale
              const py = centerY - point.dy * scale
              ctx.fillRect(px - 1, py - 1, 2, 2)
            }
          }
          ctx.globalAlpha = 1
        }
      } else {
        ctx.fillStyle = lineColor
        ctx.globalAlpha = 0.85

        for (const chunk of pendingChunks) {
          for (let i = 0; i < chunk.left.length; i++) {
            const point = transformPoint(chunk.left[i], chunk.right[i], mode)
            if (!point) continue

            const px = centerX + point.dx * scale
            const py = centerY - point.dy * scale
            ctx.fillRect(px - 1, py - 1, 2, 2)
          }
        }
        ctx.globalAlpha = 1
      }

      animationRef.current = window.requestAnimationFrame(draw)
    }

    animationRef.current = window.requestAnimationFrame(draw)

    return () => {
      if (animationRef.current !== null) {
        window.cancelAnimationFrame(animationRef.current)
        animationRef.current = null
      }
      if (isNativeAvailable()) {
        nativeVectorscope.reset()
      }
      pendingChunksRef.current = []
      configuredSampleRateRef.current = 0
    }
  }, [canvasSizeRef])

  return (
    <div ref={containerRef} className="scope-popout-canvas-wrap">
      <canvas ref={canvasRef} className="scope-popout-canvas" />
    </div>
  )
}

function SpectrogramScopeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<Spectrogram | null>(null)

  const pendingChunksRef = useRef<Float32Array[]>([])
  const sampleRateRef = useRef(48000)
  const fftSizeRef = useRef(DEFAULT_SPECTRUM_FFT_SIZE)
  const lineColorRef = useRef(DEFAULT_SPECTRUM_LINE_COLOR)
  const scrollSpeedRef = useRef(DEFAULT_SPECTROGRAM_SCROLL_SPEED)
  const clarityModeRef = useRef(DEFAULT_SPECTROGRAM_CLARITY_MODE)
  const scaleModeRef = useRef(DEFAULT_SPECTROGRAM_SCALE_MODE)
  const isPlayingRef = useRef(false)

  const handleResize = useCallback(() => {
    if (!canvasRef.current || !containerRef.current) return
    resizeCanvasToContainer(canvasRef.current, containerRef.current)
    visualizerRef.current?.resize()
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI.scopePopout.onChunk((chunk) => {
      if (chunk.scope !== 'spectrogram') return
      sampleRateRef.current = Math.max(1, chunk.sampleRate)
      const nextFftSize = Math.max(1024, chunk.fftSize)
      const nextLineColor = chunk.lineColor
      const nextScrollSpeed = clampSpectrogramScrollSpeed(chunk.spectrogramScrollSpeed)
      const nextClarityMode = isSpectrogramClarityMode(chunk.spectrogramClarityMode)
        ? chunk.spectrogramClarityMode
        : DEFAULT_SPECTROGRAM_CLARITY_MODE
      const nextScaleMode = isSpectrogramScaleMode(chunk.spectrogramScaleMode)
        ? chunk.spectrogramScaleMode
        : DEFAULT_SPECTROGRAM_SCALE_MODE

      fftSizeRef.current = nextFftSize
      lineColorRef.current = nextLineColor
      scrollSpeedRef.current = nextScrollSpeed
      clarityModeRef.current = nextClarityMode
      scaleModeRef.current = nextScaleMode

      if (chunk.reset) {
        pendingChunksRef.current = []
        isPlayingRef.current = false
      } else if (chunk.monoChunks.length > 0) {
        pendingChunksRef.current.push(...chunk.monoChunks)
        isPlayingRef.current = true
      }

      visualizerRef.current?.setOptions({
        fftSize: nextFftSize,
        lineColor: nextLineColor,
        scrollSpeed: nextScrollSpeed,
        clarityMode: nextClarityMode,
        scaleMode: nextScaleMode,
      })
    })

    return () => unsubscribe()
  }, [])

  useEffect(() => {
    handleResize()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new Spectrogram(canvasRef.current, {
        fftSize: fftSizeRef.current,
        lineColor: lineColorRef.current,
        scrollSpeed: scrollSpeedRef.current,
        clarityMode: clarityModeRef.current,
        scaleMode: scaleModeRef.current,
        colorScheme: 'heat',
        dataSource: {
          getPendingSpectrogramSamples: () => {
            const chunks = pendingChunksRef.current
            pendingChunksRef.current = []
            return chunks
          },
          getSampleRate: () => sampleRateRef.current,
          isPlaying: () => isPlayingRef.current,
        },
      })
    }

    visualizerRef.current?.start()

    return () => {
      visualizerRef.current?.dispose()
      visualizerRef.current = null
      pendingChunksRef.current = []
      isPlayingRef.current = false
    }
  }, [handleResize])

  useEffect(() => {
    handleResize()

    const observer = new ResizeObserver(() => {
      handleResize()
    })
    if (containerRef.current) observer.observe(containerRef.current)

    window.addEventListener('resize', handleResize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [handleResize])

  return (
    <div ref={containerRef} className="scope-popout-canvas-wrap">
      <canvas ref={canvasRef} className="scope-popout-canvas" />
    </div>
  )
}

function VUMeterScopeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const visualizerRef = useRef<VUMeter | null>(null)

  const pendingChunksRef = useRef<Array<{ left: Float32Array; right: Float32Array }>>([])
  const sampleRateRef = useRef(48000)
  const lineColorRef = useRef(DEFAULT_SPECTRUM_LINE_COLOR)
  const vuMeterModeRef = useRef<VUMeterMode>(DEFAULT_VU_METER_MODE)
  const isPlayingRef = useRef(false)

  const handleResize = useCallback(() => {
    if (!canvasRef.current || !containerRef.current) return
    resizeCanvasToContainer(canvasRef.current, containerRef.current)
    visualizerRef.current?.resize()
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI.scopePopout.onChunk((chunk) => {
      if (chunk.scope !== 'vumeter') return
      sampleRateRef.current = Math.max(1, chunk.sampleRate)
      lineColorRef.current = chunk.lineColor

      if ('vuMeterMode' in chunk && isVUMeterMode(chunk.vuMeterMode)) {
        vuMeterModeRef.current = chunk.vuMeterMode
      }

      if (chunk.reset) {
        pendingChunksRef.current = []
        isPlayingRef.current = false
      } else if (chunk.stereoChunks.length > 0) {
        pendingChunksRef.current.push(...chunk.stereoChunks)
        isPlayingRef.current = true
      }

      visualizerRef.current?.setOptions({
        lineColor: chunk.lineColor,
        mode: vuMeterModeRef.current,
      })
    })

    return () => unsubscribe()
  }, [])

  useEffect(() => {
    handleResize()

    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new VUMeter(canvasRef.current, {
        lineColor: lineColorRef.current,
        mode: vuMeterModeRef.current,
        dataSource: {
          getPendingVUMeterSamples: () => {
            const chunks = pendingChunksRef.current
            pendingChunksRef.current = []
            return chunks
          },
          getSampleRate: () => sampleRateRef.current,
          isPlaying: () => isPlayingRef.current,
        },
      })
    }

    visualizerRef.current?.start()

    return () => {
      visualizerRef.current?.dispose()
      visualizerRef.current = null
      pendingChunksRef.current = []
      isPlayingRef.current = false
    }
  }, [handleResize])

  useEffect(() => {
    handleResize()

    const observer = new ResizeObserver(() => {
      handleResize()
    })
    if (containerRef.current) observer.observe(containerRef.current)

    window.addEventListener('resize', handleResize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [handleResize])

  return (
    <div ref={containerRef} className="scope-popout-canvas-wrap">
      <canvas ref={canvasRef} className="scope-popout-canvas" />
    </div>
  )
}

function ScopeCanvas({ scope }: { scope: ScopeKind }) {
  switch (scope) {
    case 'spectrum':
      return <SpectrumScopeCanvas />
    case 'oscilloscope':
      return <OscilloscopeScopeCanvas />
    case 'vectorscope':
      return <VectorscopeScopeCanvas />
    case 'spectrogram':
      return <SpectrogramScopeCanvas />
    case 'vumeter':
      return <VUMeterScopeCanvas />
  }
}

function getScopeFromQuery(): ScopeKind | null {
  const rawScope = new URLSearchParams(window.location.search).get('scope')
  return isScopeKind(rawScope) ? rawScope : null
}

export default function ScopePopoutApp() {
  const scope = useMemo(() => getScopeFromQuery(), [])

  if (!scope) {
    return (
      <div className="scope-popout-root">
        <div className="scope-popout-invalid">
          <div className="scope-popout-invalid-title">Invalid scope target</div>
          <div className="scope-popout-invalid-hint">Open popouts from the analyzer deck buttons.</div>
        </div>
      </div>
    )
  }

  const label = getScopeLabel(scope)
  const handleRecall = () => {
    void window.electronAPI.scopePopout.recall(scope)
  }

  return (
    <div className="scope-popout-root">
      <header className="scope-popout-header">
        <div className="scope-popout-drag">
          <span className="scope-popout-badge">ASTRA</span>
          <span className="scope-popout-title">{label.toUpperCase()}</span>
        </div>
        <div className="scope-popout-controls">
          <button
            className="scope-popout-btn"
            onClick={handleRecall}
            title="Dock back in Astra"
            aria-label="Dock back in Astra"
          >
            Dock
          </button>
        </div>
      </header>
      <main className="scope-popout-body">
        <ScopeCanvas scope={scope} />
      </main>
    </div>
  )
}
