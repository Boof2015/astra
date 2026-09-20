import { type RefObject, useEffect, useRef } from 'react'
import { bindHorizontalWheelScroll } from '../utils/horizontalWheelScrollBinding'

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

    cleanupRef.current = bindHorizontalWheelScroll(element)
  })

  useEffect(() => {
    return () => {
      cleanupRef.current?.()
      cleanupRef.current = null
      attachedElementRef.current = null
    }
  }, [])
}
