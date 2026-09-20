import { type RefObject, useEffect, useRef } from 'react'
import { resolveHorizontalWheelScroll } from '../utils/horizontalWheelScroll'

export function useHorizontalWheelScroll<TElement extends HTMLElement>(
  ref: RefObject<TElement | null>
): void {
  const cleanupRef = useRef<(() => void) | null>(null)
  const attachedElementRef = useRef<TElement | null>(null)

  useEffect(() => {
    const element = ref.current
    if (attachedElementRef.current === element) return

    cleanupRef.current?.()
    cleanupRef.current = null
    attachedElementRef.current = element

    if (!element) return

    const handleWheel = (event: WheelEvent) => {
      const result = resolveHorizontalWheelScroll(element, {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode
      })

      if (!result.handled) return

      event.preventDefault()
      element.scrollLeft = result.nextScrollLeft
    }

    element.addEventListener('wheel', handleWheel, { passive: false })

    cleanupRef.current = () => {
      element.removeEventListener('wheel', handleWheel)
    }
  })

  useEffect(() => {
    return () => {
      cleanupRef.current?.()
      cleanupRef.current = null
      attachedElementRef.current = null
    }
  }, [])
}
