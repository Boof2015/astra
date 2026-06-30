import { useEffect, useRef, useState } from 'react'

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
 *
 * The visibility edge is handled during render (not in an effect) so that the
 * first committed frame of a newly-shown element already carries the hidden
 * `entering` styles. Flipping to `entered` afterwards then has a painted
 * baseline to transition from — without this the enter would pop in while the
 * exit still animated, because the element would first mount in its visible
 * base state.
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

  if (visible) retainedValueRef.current = value as T

  if (visible !== previousVisibleRef.current) {
    previousVisibleRef.current = visible
    if (prefersReducedMotion()) {
      if (!visible) retainedValueRef.current = null
      setPhase(visible ? 'entered' : 'exited')
    } else {
      // Start hidden on the first committed frame, then animate from there.
      setPhase(visible ? 'entering' : 'exiting')
    }
  }

  // Once the hidden `entering` frame has painted, advance to `entered` so the
  // CSS transition runs. A single rAF guarantees we are past a paint boundary.
  useEffect(() => {
    if (phase !== 'entering') return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      setPhase('entered')
    })
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [phase])

  // Hold the element mounted through the exit transition, then release it.
  useEffect(() => {
    if (phase !== 'exiting') return
    const timeout = window.setTimeout(() => {
      retainedValueRef.current = null
      setPhase('exited')
    }, exitMs)
    return () => window.clearTimeout(timeout)
  }, [exitMs, phase])

  return {
    phase,
    presentValue: visible ? value as T : retainedValueRef.current,
    shouldRender: visible || (phase !== 'exited' && retainedValueRef.current !== null)
  }
}
