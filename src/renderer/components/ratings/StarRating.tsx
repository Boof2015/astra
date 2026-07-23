import { useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent, ReactElement } from 'react'
import { MAX_TRACK_RATING, MIN_TRACK_RATING } from '../../../shared/ratings/trackRating'

interface StarRatingProps {
  value: number | null
  onCommit?: (value: number | null) => void
  onPreview?: (value: number | null) => void
  size?: 'sm' | 'md'
  ariaLabel?: string
  indeterminate?: boolean
}

// Stars render with no flex gap so the fill-overlay width percentage maps
// exactly onto star fractions (each glyph owns 1/5 of the row); the star
// path's own viewBox padding provides the visual spacing.
function StarGlyphs(): ReactElement {
  return (
    <>
      {Array.from({ length: 5 }, (_, index) => (
        <svg key={index} className="star-rating-glyph" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
        </svg>
      ))}
    </>
  )
}

function ratingFromClientX(clientX: number, element: HTMLElement): number {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0) return MIN_TRACK_RATING
  const raw = ((clientX - rect.left) / rect.width) * MAX_TRACK_RATING
  const halfStepped = Math.ceil(raw * 2) / 2
  return Math.min(MAX_TRACK_RATING, Math.max(MIN_TRACK_RATING, halfStepped))
}

function formatRatingText(value: number | null): string {
  return value === null ? 'Unrated' : `${value} star${value === 1 ? '' : 's'}`
}

export default function StarRating({
  value,
  onCommit,
  onPreview,
  size = 'sm',
  ariaLabel = 'Track rating',
  indeterminate = false
}: StarRatingProps): ReactElement {
  const [tentative, setTentative] = useState<number | null>(null)
  const didDragRef = useRef(false)
  const pressedValueRef = useRef<number | null>(null)

  const interactive = typeof onCommit === 'function'
  const displayValue = tentative ?? value
  const fillPercent = indeterminate && displayValue === null
    ? 100
    : ((displayValue ?? 0) / MAX_TRACK_RATING) * 100

  const updateTentative = (next: number) => {
    if (next !== tentative) {
      setTentative(next)
      onPreview?.(next)
    }
  }

  const clearTentative = () => {
    setTentative(null)
    onPreview?.(null)
  }

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return
    event.stopPropagation()
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const next = ratingFromClientX(event.clientX, event.currentTarget)
    didDragRef.current = false
    pressedValueRef.current = next
    updateTentative(next)
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return
    const next = ratingFromClientX(event.clientX, event.currentTarget)
    if (event.currentTarget.hasPointerCapture(event.pointerId) && next !== pressedValueRef.current) {
      didDragRef.current = true
    }
    updateTentative(next)
  }

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (pressedValueRef.current === null) return
    const next = ratingFromClientX(event.clientX, event.currentTarget)
    pressedValueRef.current = null
    // Clicking the value the track already has clears the rating (heart-toggle
    // idiom); a drag that ends on the same value keeps it.
    if (!didDragRef.current && !indeterminate && value !== null && next === value) {
      onCommit?.(null)
    } else {
      onCommit?.(next)
    }
  }

  const handlePointerLeave = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) return
    pressedValueRef.current = null
    clearTentative()
  }

  const handlePointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    pressedValueRef.current = null
    clearTentative()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return
    let next: number | null
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = value === null ? MIN_TRACK_RATING : Math.min(MAX_TRACK_RATING, value + 0.5)
        break
      case 'ArrowLeft':
      case 'ArrowDown':
        next = value !== null && value - 0.5 >= MIN_TRACK_RATING ? value - 0.5 : null
        break
      case 'Home':
        next = MIN_TRACK_RATING
        break
      case 'End':
        next = MAX_TRACK_RATING
        break
      case 'Delete':
      case 'Backspace':
        next = null
        break
      default:
        return
    }
    event.preventDefault()
    onPreview?.(next)
    onCommit?.(next)
  }

  const classNames = [
    'star-rating',
    `star-rating-${size}`,
    interactive ? 'star-rating-interactive' : '',
    displayValue === null && !indeterminate ? 'star-rating-empty' : '',
    indeterminate && displayValue === null ? 'star-rating-indeterminate' : ''
  ].filter(Boolean).join(' ')

  return (
    <div
      className={classNames}
      onPointerDown={handlePointerDown}
      onPointerMove={interactive ? handlePointerMove : undefined}
      onPointerUp={interactive ? handlePointerUp : undefined}
      onPointerLeave={interactive ? handlePointerLeave : undefined}
      onPointerCancel={interactive ? handlePointerCancel : undefined}
      onClick={interactive ? (event) => event.stopPropagation() : undefined}
      onKeyDown={handleKeyDown}
      onBlur={interactive ? clearTentative : undefined}
      role={interactive ? 'slider' : 'img'}
      tabIndex={interactive ? 0 : undefined}
      aria-label={ariaLabel}
      aria-valuemin={interactive ? 0 : undefined}
      aria-valuemax={interactive ? MAX_TRACK_RATING : undefined}
      aria-valuenow={interactive ? value ?? 0 : undefined}
      aria-valuetext={interactive ? formatRatingText(value) : undefined}
      title={indeterminate && displayValue === null ? 'Mixed ratings' : formatRatingText(displayValue)}
    >
      <div className="star-rating-stars" aria-hidden="true">
        <StarGlyphs />
      </div>
      <div className="star-rating-fill" style={{ width: `${fillPercent}%` }} aria-hidden="true">
        <div className="star-rating-stars">
          <StarGlyphs />
        </div>
      </div>
    </div>
  )
}
