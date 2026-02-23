import { useCallback, useEffect, useMemo, useRef, type MutableRefObject, type RefObject } from 'react'
import {
  isNativeAvailable,
  oscilloscope as nativeOscilloscope,
  OSCILLOSCOPE_BUFFER_SIZE,
  vectorscope as nativeVectorscope
} from '../../audio/native'
import { SpectrumAnalyzer } from '../../audio/visualizers'
import { getNormalizedOscilloscopeDisplaySamples } from '../../audio/native/oscilloscopeDisplaySamples'
import {
  isScopeKind,
  type ScopeKind,
} from '../../../types/scopePopout'
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

function drawVectorscopeGrid(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const centerX = width / 2
  const centerY = height / 2
  const radius = Math.min(centerX, centerY) * 0.9

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
  ctx.lineWidth = 1

  const rings = [0.25, 0.5, 0.75, 1]
  for (const scale of rings) {
    ctx.beginPath()
    ctx.arc(centerX, centerY, radius * scale, 0, Math.PI * 2)
    ctx.stroke()
  }

  ctx.beginPath()
  ctx.moveTo(centerX, centerY - radius)
  ctx.lineTo(centerX, centerY + radius)
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(centerX - radius, centerY)
  ctx.lineTo(centerX + radius, centerY)
  ctx.stroke()
}

function VectorscopeScopeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const canvasSizeRef = useHiDpiCanvasSize(containerRef, canvasRef)
  const animationRef = useRef<number | null>(null)

  const pendingChunksRef = useRef<Array<{ left: Float32Array; right: Float32Array }>>([])
  const sampleRateRef = useRef(48000)
  const lineColorRef = useRef('#38bdf8')
  const configuredSampleRateRef = useRef(0)

  useEffect(() => {
    const unsubscribe = window.electronAPI.scopePopout.onChunk((chunk) => {
      if (chunk.scope !== 'vectorscope') return
      sampleRateRef.current = Math.max(1, chunk.sampleRate)
      lineColorRef.current = chunk.lineColor

      if (chunk.reset) {
        pendingChunksRef.current = []
        if (isNativeAvailable()) {
          nativeVectorscope.reset()
        }
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
      const centerX = width / 2
      const centerY = height / 2
      const scale = Math.min(centerX, centerY) * 0.9 * 2.5

      ctx.clearRect(0, 0, width, height)
      drawVectorscopeGrid(ctx, width, height)

      const lineColor = lineColorRef.current

      if (isNativeAvailable()) {
        const sampleRate = sampleRateRef.current
        if (configuredSampleRateRef.current !== sampleRate) {
          nativeVectorscope.setSampleRate(sampleRate)
          configuredSampleRateRef.current = sampleRate
        }

        const pendingChunks = pendingChunksRef.current
        pendingChunksRef.current = []
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
              const px = centerX + points.x[i] * scale
              const py = centerY - points.y[i] * scale
              ctx.fillRect(px - 1, py - 1, 2, 2)
            }
          }
          ctx.globalAlpha = 1
        }
      } else {
        const pendingChunks = pendingChunksRef.current
        pendingChunksRef.current = []
        ctx.fillStyle = lineColor
        ctx.globalAlpha = 0.85

        for (const chunk of pendingChunks) {
          for (let i = 0; i < chunk.left.length; i++) {
            const px = centerX + chunk.right[i] * scale
            const py = centerY - chunk.left[i] * scale
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

function ScopeCanvas({ scope }: { scope: ScopeKind }) {
  switch (scope) {
    case 'spectrum':
      return <SpectrumScopeCanvas />
    case 'oscilloscope':
      return <OscilloscopeScopeCanvas />
    case 'vectorscope':
      return <VectorscopeScopeCanvas />
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
