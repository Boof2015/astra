import { useCallback, useEffect, useRef, useState } from 'react'
import { EQBand } from '../../types/audio'
import { isPassEQBandType } from '../../utils/eq'

interface EQBandSliderProps {
  band: EQBand
  index: number
  isPreamp?: boolean
  onGainChange: (gain: number) => void
  onFrequencyChange?: (frequency: number) => void
  onQChange?: (q: number) => void
  onTypeChange?: (type: EQBand['type']) => void
  onRemove?: () => void
  isSelected: boolean
  onSelect: () => void
  canRemove?: boolean
}

const MIN_DB = -12
const MAX_DB = 12
const MIN_FREQ = 20
const MAX_FREQ = 20000
const MIN_Q = 0.1
const MAX_Q = 18

const TYPE_OPTIONS: Array<{ value: EQBand['type']; label: string }> = [
  { value: 'highpass', label: 'High Pass' },
  { value: 'highshelf', label: 'High Shelf' },
  { value: 'peaking', label: 'Peaking' },
  { value: 'lowshelf', label: 'Low Shelf' },
  { value: 'lowpass', label: 'Low Pass' },
]

type EditableField = 'gain' | 'frequency' | 'q' | null

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function formatFreq(hz: number): string {
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k`
  return `${Math.round(hz)}`
}

function formatGain(db: number): string {
  const rounded = Math.round(db * 10) / 10
  return rounded > 0 ? `+${rounded}` : `${rounded}`
}

function formatQ(q: number): string {
  const rounded = Math.round(q * 10) / 10
  return `Q ${rounded}`
}

function BandTypeIcon({ type, className }: { type: EQBand['type']; className?: string }) {
  if (type === 'highpass') {
    return (
      <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M6.25 12V9.8C6.25 8.2 7.25 6.7 8.8 5.8L14.5 4.5" />
      </svg>
    )
  }

  if (type === 'lowpass') {
    return (
      <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M1.5 4.5L7.2 5.8C8.75 6.7 9.75 8.2 9.75 9.8V12" />
      </svg>
    )
  }

  if (type === 'lowshelf') {
    return (
      <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M1.5 11.5H5C6.7 11.5 7.5 10 7.5 8V4.5H14.5" />
      </svg>
    )
  }

  if (type === 'highshelf') {
    return (
      <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M1.5 4.5H8.5V8C8.5 10 9.3 11.5 11 11.5H14.5" />
      </svg>
    )
  }

  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.5 11.5C4.5 11.5 5.5 4.5 8 4.5C10.5 4.5 11.5 11.5 14.5 11.5" />
    </svg>
  )
}

export default function EQBandSlider({
  band,
  index,
  isPreamp,
  onGainChange,
  onFrequencyChange,
  onQChange,
  onTypeChange,
  onRemove,
  isSelected,
  onSelect,
  canRemove = true,
}: EQBandSliderProps) {
  const [editingField, setEditingField] = useState<EditableField>(null)
  const [text, setText] = useState('')
  const [showTypeMenu, setShowTypeMenu] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const typeMenuRef = useRef<HTMLDivElement>(null)
  const gain = band.gain
  const gainDisabled = !isPreamp && isPassEQBandType(band.type)
  const gainValueLabel = gainDisabled ? 'N/A' : formatGain(gain)
  const gainTitle = gainDisabled ? 'Gain is not used for highpass/lowpass filters' : undefined
  const gainAriaLabel = gainDisabled
    ? `Band ${index + 1} gain is not used for ${band.type === 'highpass' ? 'highpass' : 'lowpass'} filters`
    : isPreamp
      ? 'Preamp gain in dB'
      : `Band ${index + 1} gain in dB`

  const getGainFromClientY = useCallback(
    (clientY: number, element: HTMLDivElement): number => {
      const rect = element.getBoundingClientRect()
      if (rect.height <= 0) return 0
      const percent = 1 - (clientY - rect.top) / rect.height
      return clamp(MIN_DB + percent * (MAX_DB - MIN_DB), MIN_DB, MAX_DB)
    },
    []
  )

  useEffect(() => {
    if (!showTypeMenu) return

    const handleClickOutside = (event: MouseEvent) => {
      if (typeMenuRef.current && !typeMenuRef.current.contains(event.target as Node)) {
        setShowTypeMenu(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showTypeMenu])

  useEffect(() => {
    if (!editingField) return
    const input = inputRef.current
    if (!input) return
    requestAnimationFrame(() => input.select())
  }, [editingField])

  const clearEditorState = useCallback(() => {
    setEditingField(null)
    setText('')
  }, [])

  const commitEdit = useCallback(() => {
    if (!editingField) return

    const parsed = parseFloat(text)
    if (!Number.isNaN(parsed)) {
      if (editingField === 'gain' && !gainDisabled) {
        onGainChange(clamp(parsed, MIN_DB, MAX_DB))
      } else if (editingField === 'frequency' && onFrequencyChange) {
        onFrequencyChange(Math.round(clamp(parsed, MIN_FREQ, MAX_FREQ)))
      } else if (editingField === 'q' && onQChange) {
        onQChange(clamp(parsed, MIN_Q, MAX_Q))
      }
    }

    clearEditorState()
  }, [clearEditorState, editingField, gainDisabled, onFrequencyChange, onGainChange, onQChange, text])

  const cancelEdit = useCallback(() => {
    clearEditorState()
  }, [clearEditorState])

  const startEdit = useCallback(
    (field: Exclude<EditableField, null>, event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      onSelect()
      setShowTypeMenu(false)
      setEditingField(field)
      setText('')
    },
    [onSelect]
  )

  const handleTypeToggle = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      onSelect()
      clearEditorState()
      setShowTypeMenu((open) => !open)
    },
    [clearEditorState, onSelect]
  )

  const handleTypeChange = useCallback(
    (type: EQBand['type']) => {
      if (!onTypeChange) return
      onTypeChange(type)
      setShowTypeMenu(false)
    },
    [onTypeChange]
  )

  const renderEditableValue = (
    field: Exclude<EditableField, null>,
    displayValue: string,
    className: string,
    ariaLabel: string,
    disabled = false,
    title?: string
  ) => {
    if (editingField === field) {
      return (
        <input
          ref={inputRef}
          className={`eq-inline-input ${className}`}
          type="text"
          inputMode="decimal"
          value={text}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setText(event.target.value)}
          onBlur={commitEdit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitEdit()
              ;(event.target as HTMLInputElement).blur()
            } else if (event.key === 'Escape') {
              cancelEdit()
              ;(event.target as HTMLInputElement).blur()
            }
          }}
          aria-label={ariaLabel}
          autoFocus
        />
      )
    }

    return (
      <button
        type="button"
        className={`eq-inline-value ${className} ${disabled ? 'disabled' : ''}`}
        onPointerDown={(event) => {
          if (!disabled) {
            event.stopPropagation()
          }
        }}
        onClick={(event) => {
          if (disabled) return
          startEdit(field, event)
        }}
        aria-label={ariaLabel}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : undefined}
        title={title}
      >
        {displayValue}
      </button>
    )
  }

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (gainDisabled) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      onSelect()
      setShowTypeMenu(false)
      onGainChange(getGainFromClientY(e.clientY, e.currentTarget))
    },
    [gainDisabled, onSelect, onGainChange, getGainFromClientY]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (gainDisabled) return
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
      onGainChange(getGainFromClientY(e.clientY, e.currentTarget))
    },
    [gainDisabled, onGainChange, getGainFromClientY]
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
            clearEditorState()
            setShowTypeMenu(false)
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
      {renderEditableValue(
        'gain',
        gainValueLabel,
        'eq-band-gain',
        gainAriaLabel,
        gainDisabled,
        gainTitle
      )}

      {/* Vertical slider track */}
      <div
        className={`eq-slider-track ${gainDisabled ? 'disabled' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        role="slider"
        aria-valuenow={gain}
        aria-valuemin={MIN_DB}
        aria-valuemax={MAX_DB}
        aria-label={isPreamp ? 'Preamp' : `Band ${index + 1}: ${formatFreq(band.frequency)}`}
        aria-disabled={gainDisabled}
        title={gainTitle}
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
      {isPreamp ? (
        <span className="eq-band-freq">PRE</span>
      ) : (
        renderEditableValue('frequency', formatFreq(band.frequency), 'eq-band-freq', `Band ${index + 1} frequency in Hz`)
      )}

      {/* Type icon + menu */}
      {!isPreamp && (
        <div className="eq-band-type-wrap" ref={typeMenuRef}>
          <button
            type="button"
            className="eq-band-type-btn"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={handleTypeToggle}
            title="Edit band type"
            aria-label={`Band ${index + 1} type`}
            aria-haspopup="menu"
            aria-expanded={showTypeMenu}
          >
            <BandTypeIcon type={band.type} className="eq-band-type-icon" />
          </button>
          {showTypeMenu && onTypeChange && (
            <div className="eq-band-type-menu" role="menu">
              {TYPE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`eq-band-type-option ${band.type === option.value ? 'active' : ''}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    onSelect()
                    handleTypeChange(option.value)
                  }}
                  role="menuitemradio"
                  aria-checked={band.type === option.value}
                >
                  <BandTypeIcon type={option.value} className="eq-band-type-option-icon" />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {!isPreamp && (
        renderEditableValue('q', formatQ(band.Q), 'eq-band-q', `Band ${index + 1} Q value`)
      )}
    </div>
  )
}
