import { useCallback } from 'react'
import { EQBand } from '../../types/audio'

interface EQBandSliderProps {
  band: EQBand
  index: number
  isPreamp?: boolean
  onGainChange: (gain: number) => void
  onRemove?: () => void
  isSelected: boolean
  onSelect: () => void
  canRemove?: boolean
}

const MIN_DB = -12
const MAX_DB = 12

function formatFreq(hz: number): string {
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k`
  return `${Math.round(hz)}`
}

function formatGain(db: number): string {
  const rounded = Math.round(db * 10) / 10
  return rounded > 0 ? `+${rounded}` : `${rounded}`
}

export default function EQBandSlider({
  band,
  index,
  isPreamp,
  onGainChange,
  onRemove,
  isSelected,
  onSelect,
  canRemove = true,
}: EQBandSliderProps) {
  const gain = isPreamp ? band.gain : band.gain

  const getGainFromClientY = useCallback(
    (clientY: number, element: HTMLDivElement): number => {
      const rect = element.getBoundingClientRect()
      if (rect.height <= 0) return 0
      const percent = 1 - (clientY - rect.top) / rect.height
      return Math.max(MIN_DB, Math.min(MAX_DB, MIN_DB + percent * (MAX_DB - MIN_DB)))
    },
    []
  )

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      onSelect()
      onGainChange(getGainFromClientY(e.clientY, e.currentTarget))
    },
    [onSelect, onGainChange, getGainFromClientY]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
      onGainChange(getGainFromClientY(e.clientY, e.currentTarget))
    },
    [onGainChange, getGainFromClientY]
  )

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }, [])

  // Compute visual positions (0-100%)
  const gainPercent = ((gain - MIN_DB) / (MAX_DB - MIN_DB)) * 100
  const zeroPercent = ((0 - MIN_DB) / (MAX_DB - MIN_DB)) * 100

  // Fill from center (0dB) to current value
  const fillBottom = Math.min(gainPercent, zeroPercent)
  const fillHeight = Math.abs(gainPercent - zeroPercent)

  return (
    <div
      className={`eq-band-slider ${isPreamp ? 'eq-preamp-slider' : ''} ${isSelected ? 'selected' : ''}`}
      onClick={onSelect}
    >
      {/* Remove button */}
      {!isPreamp && canRemove && onRemove && (
        <button
          className="eq-band-remove"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          title="Remove band"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </button>
      )}

      {/* Gain display */}
      <span className="eq-band-gain">{formatGain(gain)}</span>

      {/* Vertical slider track */}
      <div
        className="eq-slider-track"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        role="slider"
        aria-valuenow={gain}
        aria-valuemin={MIN_DB}
        aria-valuemax={MAX_DB}
        aria-label={isPreamp ? 'Preamp' : `Band ${index + 1}: ${formatFreq(band.frequency)}`}
      >
        {/* Zero line */}
        <div className="eq-slider-zero" style={{ bottom: `${zeroPercent}%` }} />

        {/* Fill from center */}
        <div
          className="eq-slider-fill"
          style={{
            bottom: `${fillBottom}%`,
            height: `${fillHeight}%`,
          }}
        />

        {/* Thumb */}
        <div className="eq-slider-thumb" style={{ bottom: `${gainPercent}%` }} />
      </div>

      {/* Label */}
      <span className="eq-band-freq">
        {isPreamp ? 'PRE' : formatFreq(band.frequency)}
      </span>

      {/* Type indicator */}
      {!isPreamp && (
        <span className="eq-band-type">
          {band.type === 'lowshelf' ? 'LS' : band.type === 'highshelf' ? 'HS' : 'PK'}
        </span>
      )}
    </div>
  )
}
