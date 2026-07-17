import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

interface ControllerFocusRingProps {
  active: boolean
}

// Scopes whose focused descendant should receive the controller highlight. Mirrors the CSS
// :focus rules so the ring tracks exactly what controller navigation focuses.
const HIGHLIGHT_SCOPE_SELECTOR = [
  '[data-controller-region="true"]',
  '[data-controller-scope="overlay"]',
  '.modal-overlay',
  '.track-context-menu',
  '.sidebar-playlist-popout'
].join(',')

const GLIDE_DURATION_MS = 160
const GLIDE_TRANSITION = 'transform 0.16s ease, width 0.16s ease, height 0.16s ease, '
const STATIC_TRANSITION = 'opacity 0.12s ease'

/**
 * A single floating highlight that animates to the currently focused controller target, rather than
 * relying solely on per-element CSS :focus. It glides between targets on a focus change and then
 * locks to the element so it stays glued while lists scroll.
 */
export default function ControllerFocusRing({ active }: ControllerFocusRingProps) {
  const ringRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!active) return
    const ring = ringRef.current
    if (!ring) return

    let rafId = 0
    let animateUntil = 0
    let lastTarget: HTMLElement | null = null

    const resolveTarget = (): HTMLElement | null => {
      const el = document.activeElement
      if (!(el instanceof HTMLElement) || el === document.body) return null
      return el.closest<HTMLElement>(HIGHLIGHT_SCOPE_SELECTOR) ? el : null
    }

    const hide = (): void => {
      ring.classList.remove('is-visible')
      lastTarget = null
    }

    const frame = (now: number): void => {
      const target = resolveTarget()
      const rect = target?.isConnected ? target.getBoundingClientRect() : null
      if (!target || !rect || (rect.width === 0 && rect.height === 0)) {
        hide()
        rafId = window.requestAnimationFrame(frame)
        return
      }

      if (target !== lastTarget) {
        // Glide only between two real targets; the first appearance snaps into place.
        animateUntil = lastTarget ? now + GLIDE_DURATION_MS : 0
        lastTarget = target
        const radius = window.getComputedStyle(target).borderRadius
        ring.style.borderRadius = radius && radius !== '0px' ? radius : '10px'
      }

      ring.style.transition = (now < animateUntil ? GLIDE_TRANSITION : '') + STATIC_TRANSITION
      ring.style.width = `${rect.width}px`
      ring.style.height = `${rect.height}px`
      ring.style.transform = `translate(${rect.left}px, ${rect.top}px)`
      ring.classList.add('is-visible')
      rafId = window.requestAnimationFrame(frame)
    }

    rafId = window.requestAnimationFrame(frame)
    return () => {
      window.cancelAnimationFrame(rafId)
      hide()
    }
  }, [active])

  return createPortal(
    <div ref={ringRef} className="controller-focus-ring" aria-hidden="true" />,
    document.body
  )
}
