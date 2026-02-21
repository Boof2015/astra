import { useCallback, useEffect, useMemo, useRef, type MutableRefObject, type RefObject } from 'react'
import {
  isNativeAvailable,
  oscilloscope as nativeOscilloscope,
  OSCILLOSCOPE_BUFFER_SIZE,
  spectrum as nativeSpectrum,
  vectorscope as nativeVectorscope
} from '../../audio/native'
import {
  isScopeKind,
  type ScopeKind,
} from '../../../types/scopePopout'
import '../../styles/scope-popout.css'

const SPECTRUM_MIN_DB = -90
const SPECTRUM_MAX_DB = -10
const OSCILLOSCOPE_WARMUP_SAMPLES = 4096
const OSCILLOSCOPE_DISPLAY_SAMPLES = 2048

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

function getNativeSpectrumSmoothing(fftSize: number): number {
  const base = 0.9
  const fftRatio = Math.max(0.5, fftSize / 2048)
  return Math.min(0.99, Math.max(0, Math.pow(base, fftRatio)))
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

    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
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
  const canvasSizeRef = useHiDpiCanvasSize(containerRef, canvasRef)
  const animationRef = useRef<number | null>(null)

  const pendingChunksRef = useRef<Float32Array[]>([])
  const sampleRateRef = useRef(48000)
  const fftSizeRef = useRef(4096)
  const lineColorRef = useRef('#38bdf8')
  const spectrumDataRef = useRef<Float32Array | null>(null)
  const configuredSampleRateRef = useRef(0)
  const configuredFftSizeRef = useRef(0)

  useEffect(() => {
    const unsubscribe = window.electronAPI.scopePopout.onChunk((chunk) => {
      if (chunk.scope !== 'spectrum') return
      sampleRateRef.current = Math.max(1, chunk.sampleRate)
      fftSizeRef.current = Math.max(1024, chunk.fftSize)
      lineColorRef.current = chunk.lineColor

      if (chunk.reset) {
        pendingChunksRef.current = []
        spectrumDataRef.current = null
        if (isNativeAvailable()) {
          nativeSpectrum.reset()
        }
        return
      }

      if (chunk.monoChunks.length > 0) {
        pendingChunksRef.current.push(...chunk.monoChunks)
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
      const fftSize = fftSizeRef.current
      if (configuredSampleRateRef.current !== sampleRate) {
        nativeSpectrum.setSampleRate(sampleRate)
        configuredSampleRateRef.current = sampleRate
      }
      if (configuredFftSizeRef.current !== fftSize) {
        nativeSpectrum.setFFTSize(fftSize)
        nativeSpectrum.setSmoothing(getNativeSpectrumSmoothing(fftSize))
        configuredFftSizeRef.current = fftSize
      }

      const pendingChunks = pendingChunksRef.current
      pendingChunksRef.current = []
      for (const chunk of pendingChunks) {
        const result = nativeSpectrum.process(chunk)
        if (result && result.length > 0) {
          spectrumDataRef.current = result
        }
      }

      const frequencyData = spectrumDataRef.current
      if (!frequencyData || frequencyData.length === 0) {
        animationRef.current = window.requestAnimationFrame(draw)
        return
      }

      const nyquist = sampleRate / 2
      const minFrequency = 20
      const maxFrequency = Math.max(minFrequency + 1, Math.min(20000, nyquist))
      const binWidth = nyquist / frequencyData.length
      const pointCount = Math.max(2, Math.floor(width))
      const points: Array<{ x: number; y: number }> = []

      for (let i = 0; i < pointCount; i++) {
        const t = i / (pointCount - 1)
        const frequency = minFrequency * Math.pow(maxFrequency / minFrequency, t)
        const bin = frequency / binWidth
        const low = Math.floor(bin)
        const high = Math.min(low + 1, frequencyData.length - 1)
        const frac = bin - low

        const dbLow = frequencyData[low] ?? SPECTRUM_MIN_DB
        const dbHigh = frequencyData[high] ?? SPECTRUM_MIN_DB
        const db = dbLow + (dbHigh - dbLow) * frac
        const normalized = (db - SPECTRUM_MIN_DB) / (SPECTRUM_MAX_DB - SPECTRUM_MIN_DB)
        const clamped = Math.max(0, Math.min(1, normalized))
        const y = height - Math.pow(clamped, 0.85) * height
        points.push({ x: t * width, y })
      }

      const lineColor = lineColorRef.current
      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y)
      }
      ctx.lineTo(width, height)
      ctx.lineTo(0, height)
      ctx.closePath()
      ctx.globalAlpha = 0.18
      ctx.fillStyle = lineColor
      ctx.fill()
      ctx.globalAlpha = 1

      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y)
      }
      ctx.lineWidth = 1.7
      ctx.strokeStyle = lineColor
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
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
        nativeSpectrum.reset()
      }
      pendingChunksRef.current = []
      spectrumDataRef.current = null
      configuredSampleRateRef.current = 0
      configuredFftSizeRef.current = 0
    }
  }, [canvasSizeRef])

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
  const lineColorRef = useRef('#38bdf8')
  const samplesReceivedRef = useRef(0)
  const configuredSampleRateRef = useRef(0)
  const configuredPitchLockRef = useRef<boolean | null>(null)

  useEffect(() => {
    const unsubscribe = window.electronAPI.scopePopout.onChunk((chunk) => {
      if (chunk.scope !== 'oscilloscope') return
      sampleRateRef.current = Math.max(1, chunk.sampleRate)
      pitchLockRef.current = chunk.pitchLock
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
        configuredSampleRateRef.current = sampleRate
      }
      if (configuredPitchLockRef.current !== pitchLock) {
        nativeOscilloscope.setPitchLock(pitchLock)
        configuredPitchLockRef.current = pitchLock
      }
      nativeOscilloscope.setDisplaySamples(OSCILLOSCOPE_DISPLAY_SAMPLES)

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
      ctx.beginPath()
      const sliceWidth = width / result.samplesToShow
      for (let i = 0; i < result.samplesToShow && i < renderData.length; i++) {
        const x = i * sliceWidth
        const y = ((1 - renderData[i] * 1.8) / 2) * height
        if (i === 0) {
          ctx.moveTo(x, y)
        } else {
          ctx.lineTo(x, y)
        }
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
