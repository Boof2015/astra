import { useState, type FocusEvent, type PointerEvent } from 'react'
import { useMediaQuery } from './useMediaQuery'

export const HOVER_REVEAL_DELAY_MS = 700
export const HOVER_REVEAL_PIXELS_PER_SECOND = 25

/** Bind to the whole card so crossing its text, artwork and controls keeps one reveal. */
export function useHoverRevealCard(resetKey: string, enabled = true) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

  return {
    reducedMotion,
    textProps: { active: enabled && !reducedMotion && (hovered || focused), reducedMotion, resetKey },
    cardProps: {
      onPointerEnter: (event: PointerEvent<HTMLElement>) => {
        if (event.pointerType !== 'touch' && window.matchMedia('(any-hover: hover)').matches) setHovered(true)
      },
      onPointerLeave: () => setHovered(false),
      onPointerCancel: () => setHovered(false),
      // A mouse/touch click must not leave a card revealing after the pointer leaves.
      onPointerDownCapture: () => setFocused(false),
      onFocusCapture: (event: FocusEvent<HTMLElement>) => {
        setFocused(event.target.matches(':focus-visible') || document.documentElement.dataset.inputModality === 'controller')
      },
      onBlurCapture: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }
    }
  }
}
