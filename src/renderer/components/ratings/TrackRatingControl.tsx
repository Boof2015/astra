import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { useRatingsStore } from '../../stores/ratingsStore'
import { usePresence } from '../../hooks/usePresence'
import StarRating from './StarRating'
import RatingCalibrationLadder from './RatingCalibrationLadder'

interface TrackRatingControlProps {
  trackPaths: string[]
  size?: 'sm' | 'md'
  onCommitted?: () => void
  // The ladder strips anchor above/below the widget, which only makes sense in
  // a track row; the context menu passes false so chips never overlap menu items.
  calibration?: boolean
}

export default function TrackRatingControl({
  trackPaths,
  size = 'sm',
  onCommitted,
  calibration = true
}: TrackRatingControlProps): ReactElement {
  const ratings = useRatingsStore((s) => s.ratings)
  const setTrackRating = useRatingsStore((s) => s.setTrackRating)
  const [tentative, setTentative] = useState<number | null>(null)

  const { value, indeterminate } = useMemo(() => {
    let shared: number | null | undefined
    for (const trackPath of trackPaths) {
      const rating = ratings.get(trackPath)?.rating ?? null
      if (shared === undefined) {
        shared = rating
      } else if (shared !== rating) {
        return { value: null, indeterminate: true }
      }
    }
    return { value: shared ?? null, indeterminate: false }
  }, [ratings, trackPaths])

  const handleCommit = (rating: number | null) => {
    void setTrackRating(trackPaths, rating)
    onCommitted?.()
  }

  const ladderPresence = usePresence(calibration ? tentative : null)

  return (
    <div className={`track-rating-control track-rating-control-${size}`}>
      <StarRating
        value={value}
        indeterminate={indeterminate}
        size={size}
        onCommit={handleCommit}
        onPreview={calibration ? setTentative : undefined}
        ariaLabel={trackPaths.length > 1 ? `Rating for ${trackPaths.length} tracks` : 'Track rating'}
      />
      {ladderPresence.shouldRender && ladderPresence.presentValue !== null ? (
        <RatingCalibrationLadder
          tentative={ladderPresence.presentValue}
          trackPaths={trackPaths}
          presencePhase={ladderPresence.phase}
        />
      ) : null}
    </div>
  )
}
