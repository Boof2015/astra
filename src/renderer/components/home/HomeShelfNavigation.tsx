import { useEffect, useState, type RefObject } from 'react'

export default function HomeShelfNavigation({
  scrollRef,
  label
}: {
  scrollRef: RefObject<HTMLDivElement | null>
  label: string
}) {
  const [scrollState, setScrollState] = useState({ hasOverflow: false, canScrollBack: false, canScrollForward: false })

  useEffect(() => {
    const element = scrollRef.current
    if (!element) {
      setScrollState((current) => current.hasOverflow
        ? { hasOverflow: false, canScrollBack: false, canScrollForward: false }
        : current)
      return
    }
    const update = () => {
      const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth)
      const nextState = {
        hasOverflow: maxScrollLeft > 2,
        canScrollBack: element.scrollLeft > 2,
        canScrollForward: element.scrollLeft < maxScrollLeft - 2
      }
      setScrollState((current) => (
        current.hasOverflow === nextState.hasOverflow
        && current.canScrollBack === nextState.canScrollBack
        && current.canScrollForward === nextState.canScrollForward
          ? current
          : nextState
      ))
    }
    const resizeObserver = new ResizeObserver(update)
    const mutationObserver = new MutationObserver(update)
    resizeObserver.observe(element)
    mutationObserver.observe(element, { childList: true, subtree: true })
    element.addEventListener('scroll', update, { passive: true })
    const frameId = window.requestAnimationFrame(update)
    return () => {
      window.cancelAnimationFrame(frameId)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      element.removeEventListener('scroll', update)
    }
  })

  if (!scrollState.hasOverflow) return null

  const move = (direction: -1 | 1) => {
    const element = scrollRef.current
    if (!element) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    element.scrollBy({
      left: direction * Math.max(260, element.clientWidth * 0.72),
      behavior: reducedMotion ? 'auto' : 'smooth'
    })
  }

  return (
    <div className="home-shelf-navigation" aria-label={`${label} shelf navigation`}>
      <button
        type="button"
        onClick={() => move(-1)}
        disabled={!scrollState.canScrollBack}
        data-controller-focusable={scrollState.canScrollBack ? 'true' : undefined}
        aria-label={`Scroll ${label} left`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <button
        type="button"
        onClick={() => move(1)}
        disabled={!scrollState.canScrollForward}
        data-controller-focusable={scrollState.canScrollForward ? 'true' : undefined}
        aria-label={`Scroll ${label} right`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
      </button>
    </div>
  )
}
