import { useCallback, useEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import { measureCanvasResizeState, type CanvasResizeState } from '../utils/canvasSizing'

export type { CanvasResizeState }

interface CanvasSize {
  width: number
  height: number
}

interface UseBufferedCanvasResizeOptions {
  onResize?: (state: CanvasResizeState) => void
  scaleContextToDpr?: boolean
  deferBackingStoreResizeMs?: number
}

interface BufferedCanvasResizeControls {
  applyResizeNow: () => void
  sizeRef: MutableRefObject<CanvasSize>
}

function isSameCanvasResizeState(
  left: CanvasResizeState | null,
  right: CanvasResizeState | null,
): boolean {
  if (!left || !right) return false

  return left.cssWidth === right.cssWidth
    && left.cssHeight === right.cssHeight
    && left.pixelWidth === right.pixelWidth
    && left.pixelHeight === right.pixelHeight
    && left.dpr === right.dpr
}

export function useBufferedCanvasResize<TContainer extends HTMLElement>(
  containerRef: RefObject<TContainer | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  options: UseBufferedCanvasResizeOptions = {},
): BufferedCanvasResizeControls {
  const {
    onResize,
    scaleContextToDpr = false,
    deferBackingStoreResizeMs = 0,
  } = options
  const onResizeRef = useRef<typeof onResize>(onResize)
  const pendingResizeRef = useRef<CanvasResizeState | null>(null)
  const resizeStateRef = useRef<CanvasResizeState | null>(null)
  const resizeFrameRef = useRef<number | null>(null)
  const resizeTimerRef = useRef<number | null>(null)
  const snapshotCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const sizeRef = useRef<CanvasSize>({ width: 0, height: 0 })

  onResizeRef.current = onResize

  const getSnapshotCanvas = useCallback((): HTMLCanvasElement => {
    if (!snapshotCanvasRef.current) {
      snapshotCanvasRef.current = document.createElement('canvas')
    }
    return snapshotCanvasRef.current
  }, [])

  const applyResize = useCallback((): void => {
    resizeFrameRef.current = null

    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const nextResize = pendingResizeRef.current ?? measureCanvasResizeState(container)
    pendingResizeRef.current = nextResize
    if (isSameCanvasResizeState(resizeStateRef.current, nextResize)) {
      return
    }

    canvas.style.width = `${nextResize.cssWidth}px`
    canvas.style.height = `${nextResize.cssHeight}px`

    const previousWidth = canvas.width
    const previousHeight = canvas.height
    let hasSnapshot = false

    if (previousWidth > 0 && previousHeight > 0) {
      const snapshotCanvas = getSnapshotCanvas()
      snapshotCanvas.width = previousWidth
      snapshotCanvas.height = previousHeight
      const snapshotContext = snapshotCanvas.getContext('2d')
      if (snapshotContext) {
        snapshotContext.clearRect(0, 0, previousWidth, previousHeight)
        snapshotContext.drawImage(canvas, 0, 0)
        hasSnapshot = true
      }
    }

    canvas.width = nextResize.pixelWidth
    canvas.height = nextResize.pixelHeight

    const context = canvas.getContext('2d')
    if (hasSnapshot && context) {
      const snapshotCanvas = getSnapshotCanvas()
      context.drawImage(
        snapshotCanvas,
        0,
        0,
        previousWidth,
        previousHeight,
        0,
        0,
        nextResize.pixelWidth,
        nextResize.pixelHeight,
      )
    }

    if (scaleContextToDpr && context) {
      context.setTransform(nextResize.dpr, 0, 0, nextResize.dpr, 0, 0)
    }

    resizeStateRef.current = nextResize
    sizeRef.current = {
      width: nextResize.cssWidth,
      height: nextResize.cssHeight,
    }
    onResizeRef.current?.(nextResize)
  }, [canvasRef, containerRef, getSnapshotCanvas, scaleContextToDpr])

  const scheduleResize = useCallback((): void => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container) return

    pendingResizeRef.current = measureCanvasResizeState(container)

    if (deferBackingStoreResizeMs > 0) {
      if (canvas) {
        canvas.style.width = `${pendingResizeRef.current.cssWidth}px`
        canvas.style.height = `${pendingResizeRef.current.cssHeight}px`
      }
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current)
        resizeFrameRef.current = null
      }
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current)
      }
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null
        resizeFrameRef.current = window.requestAnimationFrame(() => {
          applyResize()
        })
      }, deferBackingStoreResizeMs)
      return
    }

    if (resizeFrameRef.current !== null) return

    resizeFrameRef.current = window.requestAnimationFrame(() => {
      applyResize()
    })
  }, [applyResize, canvasRef, containerRef, deferBackingStoreResizeMs])

  const applyResizeNow = useCallback((): void => {
    const container = containerRef.current
    if (!container) return

    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current)
      resizeFrameRef.current = null
    }
    if (resizeTimerRef.current !== null) {
      window.clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = null
    }

    pendingResizeRef.current = measureCanvasResizeState(container)
    applyResize()
  }, [applyResize, containerRef])

  useEffect(() => {
    applyResizeNow()

    const container = containerRef.current
    const resizeObserver = typeof ResizeObserver === 'undefined' || !container
      ? null
      : new ResizeObserver(() => {
          scheduleResize()
        })

    if (resizeObserver && container) {
      resizeObserver.observe(container)
    }
    window.addEventListener('resize', scheduleResize)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', scheduleResize)
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current)
        resizeFrameRef.current = null
      }
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = null
      }
      pendingResizeRef.current = null
      resizeStateRef.current = null
      if (snapshotCanvasRef.current) {
        snapshotCanvasRef.current.width = 0
        snapshotCanvasRef.current.height = 0
      }
      snapshotCanvasRef.current = null
      sizeRef.current = { width: 0, height: 0 }
    }
  }, [applyResizeNow, containerRef, scheduleResize])

  return {
    applyResizeNow,
    sizeRef,
  }
}
