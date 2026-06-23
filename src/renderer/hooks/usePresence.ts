import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export const STRUCTURAL_MOTION_ENTER_MS = 190
export const STRUCTURAL_MOTION_EXIT_MS = 140

export type PresencePhase = 'entering' | 'entered' | 'exiting' | 'exited'

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export interface PresenceResult<T> {
  phase: PresencePhase
  presentValue: T | null
  shouldRender: boolean
}

/**
 * Retains the most recent truthy value long enough for a short exit transition.
 * Reopening during that window cancels the pending unmount.
 */
export function usePresence<T>(
  value: T | null | undefined | false,
  exitMs = STRUCTURAL_MOTION_EXIT_MS
): PresenceResult<T> {
  const visible = value !== null && value !== undefined && value !== false
  const retainedValueRef = useRef<T | null>(visible ? value as T : null)
  const [phase, setPhase] = useState<PresencePhase>(visible ? 'entered' : 'exited')
  const previousVisibleRef = useRef(visible)
  const frameRef = useRef<number | null>(null)
  const timeoutRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (visible) retainedValueRef.current = value as T
  }, [value, visible])

  useLayoutEffect(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }

    const wasVisible = previousVisibleRef.current
    previousVisibleRef.current = visible
    if (visible === wasVisible) return

    if (visible) {
      if (prefersReducedMotion()) {
        setPhase('entered')
        return
      }
      setPhase('entering')
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null
          setPhase('entered')
        })
      })
      return
    }

    if (prefersReducedMotion()) {
      retainedValueRef.current = null
      setPhase('exited')
      return
    }
    setPhase('exiting')
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null
      retainedValueRef.current = null
      setPhase('exited')
    }, exitMs)
  }, [exitMs, visible])

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
  }, [])

  return {
    phase,
    presentValue: visible ? value as T : retainedValueRef.current,
    shouldRender: visible || (phase !== 'exited' && retainedValueRef.current !== null)
  }
}
