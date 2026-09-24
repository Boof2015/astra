import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { HOVER_REVEAL_DELAY_MS, HOVER_REVEAL_PIXELS_PER_SECOND } from '../../hooks/useHoverRevealCard'

interface HoverRevealTextProps {
  text: string
  children?: ReactNode
  className?: string
  active: boolean
  reducedMotion: boolean
  resetKey: string
}

/** One accessible text node: inline for native ellipsis, transformable only while revealing. */
export default function HoverRevealText({ text, children, className = '', active, reducedMotion, resetKey }: HoverRevealTextProps) {
  const viewportRef = useRef<HTMLSpanElement>(null)
  const contentRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!active || !viewport || !content) return

    let timer: ReturnType<typeof setTimeout> | undefined
    let animation: Animation | undefined
    let previousWidth = -1
    let previousContentWidth = -1

    const reset = () => {
      clearTimeout(timer)
      animation?.cancel()
      animation = undefined
      delete viewport.dataset.revealing
    }
    const measure = () => {
      const width = viewport.clientWidth
      const contentWidth = content.getBoundingClientRect().width
      // ResizeObserver also fires when the inline text becomes an inline-block.
      if (Math.abs(width - previousWidth) < 0.5 && Math.abs(contentWidth - previousContentWidth) < 0.5) return
      previousWidth = width
      previousContentWidth = contentWidth
      reset()
      const distance = contentWidth - width
      if (width <= 0 || distance <= 1) return

      timer = setTimeout(() => {
        viewport.dataset.revealing = 'true'
        animation = content.animate([
          { transform: 'translateX(0)' },
          { transform: `translateX(${-distance}px)` }
        ], { duration: distance / HOVER_REVEAL_PIXELS_PER_SECOND * 1000, easing: 'linear', fill: 'forwards' })
      }, HOVER_REVEAL_DELAY_MS)
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(content)
    document.fonts.addEventListener('loadingdone', measure)
    return () => {
      observer.disconnect()
      document.fonts.removeEventListener('loadingdone', measure)
      reset()
    }
  }, [active, text, resetKey])

  return (
    <span ref={viewportRef} className={`hover-reveal-text ${className}`} title={reducedMotion ? text : undefined}>
      <span ref={contentRef} className="hover-reveal-text-content">{children ?? text}</span>
    </span>
  )
}
