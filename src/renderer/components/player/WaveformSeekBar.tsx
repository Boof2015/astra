import { useRef, useEffect, useCallback, useState, useMemo } from 'react'
import { downsampleWaveform } from '../../audio/waveformExtractor'
import { useThemeStore } from '../../stores/themeStore'

interface WaveformSeekBarProps {
  waveformData: Float32Array | null
  progress: number // 0-100
  duration: number
  currentTime: number
  bufferedRatio?: number
  analyzedRatio?: number
  seekableDuration?: number
  onSeek: (time: number) => void
}

// Target CSS pixels per bar slot (bar + gap)
const TARGET_BAR_SLOT_PX = 10

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export default function WaveformSeekBar({
  waveformData,
  progress,
  duration,
  currentTime,
  bufferedRatio = 1,
  analyzedRatio = 1,
  seekableDuration,
  onSeek
}: WaveformSeekBarProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hoverPercent, setHoverPercent] = useState<number | null>(null)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const isDraggingRef = useRef(false)
  const waveformTheme = useThemeStore((s) => s.resolvedTokens)

  // Resize observer for responsive canvas
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) {
        const { width, height } = entry.contentRect
        setCanvasSize({ width: Math.floor(width), height: Math.floor(height) })
      }
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Update canvas dimensions when size changes
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || canvasSize.width === 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = canvasSize.width * dpr
    canvas.height = canvasSize.height * dpr
    canvas.style.width = `${canvasSize.width}px`
    canvas.style.height = `${canvasSize.height}px`
  }, [canvasSize])

  // Adaptive bar count: downsample source data to fit the current width
  const displayData = useMemo(() => {
    if (!waveformData || canvasSize.width === 0) return null
    const barCount = Math.max(8, Math.floor(canvasSize.width / TARGET_BAR_SLOT_PX))
    return downsampleWaveform(waveformData, barCount)
  }, [waveformData, canvasSize.width])

  // Draw waveform
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const dpr = window.devicePixelRatio || 1
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const width = canvasSize.width * dpr
    const height = canvasSize.height * dpr
    if (width === 0 || height === 0) return

    ctx.clearRect(0, 0, width, height)

    const playedX = (progress / 100) * width
    const analyzedX = Math.max(0, Math.min(width, analyzedRatio * width))
    const effectiveSeekableDuration = seekableDuration ?? (bufferedRatio * duration)
    const seekableX = duration > 0
      ? Math.max(0, Math.min(width, (effectiveSeekableDuration / duration) * width))
      : width
    const centerY = height / 2
    const playedColor = waveformTheme.accent
    const loadedColor = waveformTheme.isLight ? 'rgba(15, 23, 42, 0.18)' : 'rgba(255, 255, 255, 0.12)'
    const unloadedColor = waveformTheme.isLight ? 'rgba(15, 23, 42, 0.08)' : 'rgba(255, 255, 255, 0.05)'
    const markerColor = waveformTheme.stageText
    const limitColor = waveformTheme.stageGrid

    if (!displayData || displayData.length === 0) {
      // Fallback: simple thin progress line
      const barHeight = 4 * dpr
      ctx.fillStyle = unloadedColor
      ctx.fillRect(0, centerY - barHeight / 2, width, barHeight)
      ctx.fillStyle = loadedColor
      ctx.fillRect(0, centerY - barHeight / 2, analyzedX, barHeight)
      ctx.fillStyle = playedColor
      ctx.fillRect(0, centerY - barHeight / 2, Math.min(playedX, analyzedX), barHeight)
      return
    }

    const barCount = displayData.length
    const totalBarSpace = width / barCount
    const gap = Math.max(2 * dpr, totalBarSpace * 0.55)
    const barWidth = Math.max(2.5 * dpr, totalBarSpace - gap)
    const maxBarHalfHeight = centerY - 2 * dpr
    const minBarHalfHeight = 1.5 * dpr
    const radius = Math.min(barWidth / 2, 2.5 * dpr)

    for (let i = 0; i < barCount; i++) {
      const x = i * totalBarSpace + gap / 2
      const peakValue = displayData[i]
      const barHalfHeight = Math.max(minBarHalfHeight, peakValue * maxBarHalfHeight)
      const barCenterX = x + barWidth / 2

      if (barCenterX <= playedX && barCenterX <= analyzedX) {
        ctx.fillStyle = playedColor
      } else if (barCenterX <= analyzedX) {
        ctx.fillStyle = loadedColor
      } else {
        ctx.fillStyle = unloadedColor
      }

      const barTop = centerY - barHalfHeight
      const barHeight = barHalfHeight * 2

      ctx.beginPath()
      ctx.roundRect(x, barTop, barWidth, barHeight, radius)
      ctx.fill()
    }

    // Playhead line — always visible during playback
    if (progress > 0) {
      ctx.strokeStyle = markerColor
      ctx.lineWidth = 2 * dpr
      ctx.beginPath()
      ctx.moveTo(playedX, 0)
      ctx.lineTo(playedX, height)
      ctx.stroke()
    }

    if (seekableX < width) {
      ctx.strokeStyle = limitColor
      ctx.lineWidth = 1 * dpr
      ctx.beginPath()
      ctx.moveTo(seekableX, 0)
      ctx.lineTo(seekableX, height)
      ctx.stroke()
    }

    // White hover/seek indicator
    if (hoverPercent !== null) {
      const hoverX = hoverPercent * width
      ctx.strokeStyle = markerColor
      ctx.lineWidth = 1.5 * dpr
      ctx.beginPath()
      ctx.moveTo(hoverX, 0)
      ctx.lineTo(hoverX, height)
      ctx.stroke()
    }
  }, [displayData, progress, hoverPercent, canvasSize, waveformTheme, analyzedRatio, bufferedRatio, duration, seekableDuration])

  // Redraw on any dependency change
  useEffect(() => {
    draw()
  }, [draw])

  // Pointer helpers
  const getPercentFromClientX = (clientX: number): number => {
    const container = containerRef.current
    if (!container) return 0
    const rect = container.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    isDraggingRef.current = true
    const percent = getPercentFromClientX(e.clientX)
    const maxSeekablePercent = duration > 0
      ? Math.max(0, Math.min(1, (seekableDuration ?? (bufferedRatio * duration)) / duration))
      : 0
    const clampedPercent = Math.min(percent, maxSeekablePercent)
    setHoverPercent(clampedPercent)
    onSeek(clampedPercent * duration)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const percent = getPercentFromClientX(e.clientX)
    const maxSeekablePercent = duration > 0
      ? Math.max(0, Math.min(1, (seekableDuration ?? (bufferedRatio * duration)) / duration))
      : 0
    const clampedPercent = Math.min(percent, maxSeekablePercent)
    setHoverPercent(clampedPercent)

    if (duration <= 0) return
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    onSeek(clampedPercent * duration)
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    isDraggingRef.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const handlePointerLeave = () => {
    if (!isDraggingRef.current) {
      setHoverPercent(null)
    }
  }

  // Hover time tooltip position
  const hoverTime = hoverPercent !== null ? hoverPercent * duration : 0

  return (
    <div
      ref={containerRef}
      className="waveform-seek-bar"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      role="slider"
      aria-valuenow={currentTime}
      aria-valuemin={0}
      aria-valuemax={duration}
    >
      <canvas ref={canvasRef} className="waveform-canvas" />
      {hoverPercent !== null && duration > 0 && (
        <div
          className="waveform-hover-time"
          style={{ left: `${hoverPercent * 100}%` }}
        >
          {formatTime(hoverTime)}
        </div>
      )}
    </div>
  )
}
