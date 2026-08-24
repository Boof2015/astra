import { useRef, useEffect, useCallback, useState, useMemo } from 'react'
import { downsampleWaveform } from '../../audio/waveformExtractor'
import { useMediaQuery } from '../../hooks/useMediaQuery'
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
const SEEK_ANIMATION_MS = 150
const PLAYHEAD_PULSE_MS = 90
const DRAG_THRESHOLD_PX = 4
const TOOLTIP_EDGE_PADDING_PX = 24
const SEEK_ACK_FALLBACK_MS = 600

interface HoverPreview {
  percent: number
  visible: boolean
}

interface PlayheadPulse {
  percent: number
  strength: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function easeOutCubic(progress: number): number {
  return 1 - Math.pow(1 - progress, 3)
}

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
  const [hoverPreview, setHoverPreview] = useState<HoverPreview>({ percent: 0, visible: false })
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const [visualProgress, setVisualProgress] = useState<number | null>(null)
  const [playheadPulse, setPlayheadPulse] = useState<PlayheadPulse | null>(null)
  const pointerActiveRef = useRef(false)
  const hasDraggedRef = useRef(false)
  const pointerStartXRef = useRef(0)
  const fillAnimationFrameRef = useRef<number | null>(null)
  const fillAnimationTargetRef = useRef<number | null>(null)
  const pulseAnimationFrameRef = useRef<number | null>(null)
  const seekAckTimerRef = useRef<number | null>(null)
  const settledSeekTargetRef = useRef<number | null>(null)
  const authoritativeProgressRef = useRef(clamp(progress, 0, 100))
  const displayedProgressRef = useRef(clamp(progress, 0, 100))
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const waveformTheme = useThemeStore((s) => s.resolvedTokens)

  const authoritativeProgress = clamp(progress, 0, 100)
  authoritativeProgressRef.current = authoritativeProgress
  const displayedProgress = visualProgress ?? authoritativeProgress
  displayedProgressRef.current = displayedProgress

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

    const playedX = (displayedProgress / 100) * width
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
    } else {
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
    }

    // Playhead line — always visible during playback
    if (displayedProgress > 0) {
      ctx.strokeStyle = markerColor
      ctx.lineWidth = 2 * dpr
      ctx.beginPath()
      ctx.moveTo(playedX, 0)
      ctx.lineTo(playedX, height)
      ctx.stroke()
    }

    if (playheadPulse) {
      const pulseX = playheadPulse.percent * width
      ctx.save()
      ctx.globalAlpha = 0.55 * playheadPulse.strength
      ctx.strokeStyle = playedColor
      ctx.lineWidth = (2 + 2 * playheadPulse.strength) * dpr
      ctx.beginPath()
      ctx.moveTo(pulseX, 0)
      ctx.lineTo(pulseX, height)
      ctx.stroke()
      ctx.restore()
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
    if (hoverPreview.visible) {
      const hoverX = hoverPreview.percent * width
      ctx.strokeStyle = markerColor
      ctx.lineWidth = 1.5 * dpr
      ctx.beginPath()
      ctx.moveTo(hoverX, 0)
      ctx.lineTo(hoverX, height)
      ctx.stroke()
    }
  }, [displayData, displayedProgress, playheadPulse, hoverPreview, canvasSize, waveformTheme, analyzedRatio, bufferedRatio, duration, seekableDuration])

  // Redraw on any dependency change
  useEffect(() => {
    draw()
  }, [draw])

  const clearSeekAckTimer = useCallback(() => {
    if (seekAckTimerRef.current === null) return
    window.clearTimeout(seekAckTimerRef.current)
    seekAckTimerRef.current = null
  }, [])

  const releaseVisualProgress = useCallback(() => {
    clearSeekAckTimer()
    settledSeekTargetRef.current = null
    displayedProgressRef.current = authoritativeProgressRef.current
    setVisualProgress(null)
  }, [clearSeekAckTimer])

  const holdVisualProgressUntilSeekCatchesUp = useCallback((targetProgress: number) => {
    clearSeekAckTimer()
    settledSeekTargetRef.current = targetProgress

    const tolerancePercent = duration > 0
      ? Math.max(0.05, (0.5 / duration) * 100)
      : 0.1
    if (Math.abs(authoritativeProgressRef.current - targetProgress) <= tolerancePercent) {
      releaseVisualProgress()
      return
    }

    seekAckTimerRef.current = window.setTimeout(() => {
      seekAckTimerRef.current = null
      if (settledSeekTargetRef.current !== targetProgress || pointerActiveRef.current) return
      releaseVisualProgress()
    }, SEEK_ACK_FALLBACK_MS)
  }, [clearSeekAckTimer, duration, releaseVisualProgress])

  useEffect(() => {
    const targetProgress = settledSeekTargetRef.current
    if (targetProgress === null || pointerActiveRef.current) return

    const tolerancePercent = duration > 0
      ? Math.max(0.05, (0.5 / duration) * 100)
      : 0.1
    if (Math.abs(authoritativeProgress - targetProgress) <= tolerancePercent) {
      releaseVisualProgress()
    }
  }, [authoritativeProgress, duration, releaseVisualProgress])

  const cancelFillAnimation = useCallback(() => {
    if (fillAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(fillAnimationFrameRef.current)
      fillAnimationFrameRef.current = null
    }
    fillAnimationTargetRef.current = null
  }, [])

  const cancelPlayheadPulse = useCallback(() => {
    if (pulseAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(pulseAnimationFrameRef.current)
      pulseAnimationFrameRef.current = null
    }
    setPlayheadPulse(null)
  }, [])

  const startPlayheadPulse = useCallback((targetPercent: number) => {
    cancelPlayheadPulse()
    if (prefersReducedMotion) return

    const startedAt = performance.now()
    const tick = (now: number) => {
      const elapsed = now - startedAt
      const motionProgress = clamp(elapsed / PLAYHEAD_PULSE_MS, 0, 1)

      if (motionProgress >= 1) {
        pulseAnimationFrameRef.current = null
        setPlayheadPulse(null)
        return
      }

      setPlayheadPulse({ percent: targetPercent, strength: 1 - motionProgress })
      pulseAnimationFrameRef.current = window.requestAnimationFrame(tick)
    }

    setPlayheadPulse({ percent: targetPercent, strength: 1 })
    pulseAnimationFrameRef.current = window.requestAnimationFrame(tick)
  }, [cancelPlayheadPulse, prefersReducedMotion])

  const setTemporaryProgress = useCallback((nextProgress: number) => {
    const clampedProgress = clamp(nextProgress, 0, 100)
    displayedProgressRef.current = clampedProgress
    setVisualProgress(clampedProgress)
  }, [])

  const startSeekAnimation = useCallback((targetPercent: number) => {
    cancelFillAnimation()
    cancelPlayheadPulse()
    clearSeekAckTimer()
    settledSeekTargetRef.current = null

    const targetProgress = clamp(targetPercent * 100, 0, 100)
    const startProgress = displayedProgressRef.current
    fillAnimationTargetRef.current = targetProgress

    if (prefersReducedMotion || Math.abs(targetProgress - startProgress) < 0.01) {
      fillAnimationTargetRef.current = null
      setTemporaryProgress(targetProgress)
      holdVisualProgressUntilSeekCatchesUp(targetProgress)
      if (!prefersReducedMotion) startPlayheadPulse(targetPercent)
      return
    }

    const startedAt = performance.now()
    const tick = (now: number) => {
      const elapsed = now - startedAt
      const motionProgress = clamp(elapsed / SEEK_ANIMATION_MS, 0, 1)
      const easedProgress = easeOutCubic(motionProgress)
      setTemporaryProgress(startProgress + (targetProgress - startProgress) * easedProgress)

      if (motionProgress >= 1) {
        fillAnimationFrameRef.current = null
        fillAnimationTargetRef.current = null
        holdVisualProgressUntilSeekCatchesUp(targetProgress)
        startPlayheadPulse(targetPercent)
        return
      }

      fillAnimationFrameRef.current = window.requestAnimationFrame(tick)
    }

    setTemporaryProgress(startProgress)
    fillAnimationFrameRef.current = window.requestAnimationFrame(tick)
  }, [cancelFillAnimation, cancelPlayheadPulse, clearSeekAckTimer, holdVisualProgressUntilSeekCatchesUp, prefersReducedMotion, setTemporaryProgress, startPlayheadPulse])

  useEffect(() => {
    if (!prefersReducedMotion) return

    const targetProgress = fillAnimationTargetRef.current
    cancelFillAnimation()
    cancelPlayheadPulse()
    if (targetProgress !== null) {
      setTemporaryProgress(targetProgress)
      holdVisualProgressUntilSeekCatchesUp(targetProgress)
    }
  }, [cancelFillAnimation, cancelPlayheadPulse, holdVisualProgressUntilSeekCatchesUp, prefersReducedMotion, setTemporaryProgress])

  useEffect(() => () => {
    if (fillAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(fillAnimationFrameRef.current)
    }
    if (pulseAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(pulseAnimationFrameRef.current)
    }
    if (seekAckTimerRef.current !== null) {
      window.clearTimeout(seekAckTimerRef.current)
    }
  }, [])

  // Pointer helpers
  const getPercentFromClientX = useCallback((clientX: number): number => {
    const container = containerRef.current
    if (!container) return 0
    const rect = container.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }, [])

  const getMaxSeekablePercent = useCallback((): number => {
    if (duration <= 0) return 0
    return clamp((seekableDuration ?? (bufferedRatio * duration)) / duration, 0, 1)
  }, [bufferedRatio, duration, seekableDuration])

  const getClampedPointerPercent = useCallback((clientX: number): number => {
    return Math.min(getPercentFromClientX(clientX), getMaxSeekablePercent())
  }, [getMaxSeekablePercent, getPercentFromClientX])

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    pointerActiveRef.current = true
    hasDraggedRef.current = false
    pointerStartXRef.current = e.clientX
    const clampedPercent = getClampedPointerPercent(e.clientX)
    setHoverPreview({ percent: clampedPercent, visible: true })
    startSeekAnimation(clampedPercent)
    onSeek(clampedPercent * duration)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return
    const clampedPercent = getClampedPointerPercent(e.clientX)
    setHoverPreview({ percent: clampedPercent, visible: true })
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return

    if (!hasDraggedRef.current && Math.abs(e.clientX - pointerStartXRef.current) > DRAG_THRESHOLD_PX) {
      hasDraggedRef.current = true
      cancelFillAnimation()
      cancelPlayheadPulse()
      clearSeekAckTimer()
      settledSeekTargetRef.current = null
    }

    if (hasDraggedRef.current) {
      setTemporaryProgress(clampedPercent * 100)
      onSeek(clampedPercent * duration)
    }
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const wasDragging = hasDraggedRef.current
    pointerActiveRef.current = false
    hasDraggedRef.current = false
    const bounds = e.currentTarget.getBoundingClientRect()
    const endedOutside = e.clientX < bounds.left
      || e.clientX > bounds.right
      || e.clientY < bounds.top
      || e.clientY > bounds.bottom
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }

    if (wasDragging) {
      const targetPercent = getClampedPointerPercent(e.clientX)
      setTemporaryProgress(targetPercent * 100)
      holdVisualProgressUntilSeekCatchesUp(targetPercent * 100)
      startPlayheadPulse(targetPercent)
      onSeek(targetPercent * duration)
    } else if (settledSeekTargetRef.current !== null) {
      holdVisualProgressUntilSeekCatchesUp(settledSeekTargetRef.current)
    }

    if (e.pointerType !== 'mouse' || endedOutside) {
      setHoverPreview((current) => ({ ...current, visible: false }))
    }
  }

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    pointerActiveRef.current = false
    hasDraggedRef.current = false
    cancelFillAnimation()
    cancelPlayheadPulse()
    releaseVisualProgress()
    setHoverPreview((current) => ({ ...current, visible: false }))
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const handlePointerLeave = () => {
    if (!pointerActiveRef.current) {
      setHoverPreview((current) => ({ ...current, visible: false }))
    }
  }

  // Hover time tooltip position
  const hoverTime = hoverPreview.percent * duration
  const tooltipEdgePercent = canvasSize.width > 0
    ? Math.min(0.5, Math.max(0.04, TOOLTIP_EDGE_PADDING_PX / canvasSize.width))
    : 0
  const tooltipPercent = clamp(hoverPreview.percent, tooltipEdgePercent, 1 - tooltipEdgePercent)

  return (
    <div
      ref={containerRef}
      className="waveform-seek-bar"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={handlePointerLeave}
      role="slider"
      aria-valuenow={currentTime}
      aria-valuemin={0}
      aria-valuemax={duration}
    >
      <canvas ref={canvasRef} className="waveform-canvas" />
      {duration > 0 && (
        <div
          className={`waveform-hover-time ${hoverPreview.visible ? 'is-visible' : ''}`.trim()}
          style={{ left: `${tooltipPercent * 100}%` }}
          aria-hidden="true"
        >
          {formatTime(hoverTime)}
        </div>
      )}
    </div>
  )
}
