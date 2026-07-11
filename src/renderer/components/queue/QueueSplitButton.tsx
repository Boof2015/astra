import { useCallback, useEffect, useRef, useState } from 'react'
import { usePlayerStore } from '../../stores/playerStore'

interface QueueSplitButtonProps {
  trackPaths: string[]
  disabled?: boolean
  className?: string
}

type QueueFeedback = 'added' | 'next' | null

const FEEDBACK_DURATION_MS = 1200

/**
 * Detail-header action button that adds a whole collection to the queue.
 * Clicking the main button appends to the end of the queue; hovering (or focusing)
 * reveals a narrower "Play Next" flyout that inserts at the front of the upcoming queue.
 */
export default function QueueSplitButton({ trackPaths, disabled, className }: QueueSplitButtonProps) {
  const enqueueTrackPaths = usePlayerStore((state) => state.enqueueTrackPaths)
  const [feedback, setFeedback] = useState<QueueFeedback>(null)
  const feedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isDisabled = disabled || trackPaths.length === 0

  useEffect(() => {
    return () => {
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current)
    }
  }, [])

  const enqueue = useCallback(
    (position: 'next' | 'end') => {
      if (isDisabled) return
      void enqueueTrackPaths(trackPaths, position)
      setFeedback(position === 'next' ? 'next' : 'added')
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current)
      feedbackTimeoutRef.current = setTimeout(() => setFeedback(null), FEEDBACK_DURATION_MS)
    },
    [enqueueTrackPaths, isDisabled, trackPaths]
  )

  const mainLabel = feedback === 'added' ? 'Added' : 'Queue'
  const nextLabel = feedback === 'next' ? 'Queued next' : 'Play Next'

  return (
    <div className={`queue-split-btn ${className ?? ''}`}>
      <button
        type="button"
        className="icon-btn library-collection-action-btn queue-split-btn-main"
        onClick={() => enqueue('end')}
        title="Add to queue"
        aria-label="Add to queue"
        disabled={isDisabled}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 6h11" />
          <path d="M4 12h11" />
          <path d="M4 18h7" />
          <path d="M17 15v6" />
          <path d="M14 18h6" />
        </svg>
        <span className="library-collection-action-label">{mainLabel}</span>
      </button>
      <button
        type="button"
        className="queue-split-btn-flyout"
        onClick={() => enqueue('next')}
        title="Play next"
        aria-label="Play next"
        disabled={isDisabled}
        tabIndex={isDisabled ? -1 : 0}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 4v16l11-8z" fill="currentColor" stroke="none" />
          <path d="M20 5v14" />
        </svg>
        <span>{nextLabel}</span>
      </button>
    </div>
  )
}
