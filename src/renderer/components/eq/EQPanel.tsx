import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useEQStore } from '../../stores/eqStore'
import { audioEngine } from '../../audio/AudioEngine'
import { EQBand } from '../../types/audio'
import EQFrequencyResponse from './EQFrequencyResponse'
import EQBandSlider from './EQBandSlider'

/** Text input that lets you clear and retype a number. Commits on blur/Enter, reverts if invalid. */
function NumericInput({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const displayValue = step < 1 ? String(Math.round(value * 10) / 10) : String(Math.round(value))

  const commit = () => {
    setEditing(false)
    const v = parseFloat(text)
    if (!isNaN(v)) {
      onChange(Math.max(min, Math.min(max, v)))
    }
  }

  return (
    <input
      className="eq-detail-input"
      type="text"
      inputMode="decimal"
      value={editing ? text : displayValue}
      onFocus={(e) => {
        setEditing(true)
        setText('')
        // defer select so the cleared value is visible
        requestAnimationFrame(() => e.target.select())
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit()
          ;(e.target as HTMLInputElement).blur()
        } else if (e.key === 'Escape') {
          setEditing(false)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

export default function EQPanel() {
  const {
    enabled,
    bands,
    preamp,
    presets,
    activePresetId,
    toggleEnabled,
    setPreamp,
    addBand,
    removeBand,
    updateBand,
    applyPreset,
    resetEQ,
    setShowEQPanel,
  } = useEQStore()

  const [selectedBandIndex, setSelectedBandIndex] = useState<number | null>(null)
  const responseAreaRef = useRef<HTMLDivElement>(null)
  const [responseDims, setResponseDims] = useState({ width: 0, height: 0 })
  const sampleRate = audioEngine.getSampleRate()

  // Track response area dimensions
  useEffect(() => {
    const el = responseAreaRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) {
        setResponseDims({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        })
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const handleBandDragOnCurve = useCallback(
    (index: number, freq: number, gain: number) => {
      updateBand(index, { frequency: freq, gain })
    },
    [updateBand]
  )

  // Band detail editing
  const selectedBand = selectedBandIndex !== null && selectedBandIndex < bands.length
    ? bands[selectedBandIndex]
    : null

  const handleDetailChange = useCallback(
    (field: keyof EQBand, value: number | string) => {
      if (selectedBandIndex === null) return
      updateBand(selectedBandIndex, { [field]: value })
    },
    [selectedBandIndex, updateBand]
  )

  return (
    <div className="eq-panel">
      {/* Header */}
      <div className="eq-header">
        <div className="eq-header-left">
          <span className="eq-header-title">Equalizer</span>
          <div
            className={`eq-toggle-switch ${enabled ? 'active' : ''}`}
            onClick={toggleEnabled}
            role="switch"
            aria-checked={enabled}
            title={enabled ? 'Disable EQ' : 'Enable EQ'}
          />
        </div>

        <div className="eq-header-right">
          <select
            className="eq-preset-select"
            value={activePresetId ?? ''}
            onChange={(e) => {
              const preset = presets.find((p) => p.id === e.target.value)
              if (preset) applyPreset(preset)
            }}
          >
            <option value="">Custom</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <button className="eq-reset-btn" onClick={resetEQ} title="Reset EQ">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
            </svg>
          </button>

          <button
            className="eq-close-btn"
            onClick={() => setShowEQPanel(false)}
            title="Close EQ"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Frequency response curve */}
      <div className="eq-response-area" ref={responseAreaRef}>
        <EQFrequencyResponse
          bands={bands}
          preamp={preamp}
          enabled={enabled}
          selectedBandIndex={selectedBandIndex}
          onBandDrag={handleBandDragOnCurve}
          onBandSelect={setSelectedBandIndex}
          sampleRate={sampleRate}
          width={responseDims.width}
          height={responseDims.height}
        />
      </div>

      {/* Band sliders area */}
      <div className="eq-sliders-area">
        {/* Preamp slider */}
        <EQBandSlider
          band={{ id: 'preamp', type: 'peaking', frequency: 0, gain: preamp, Q: 0 }}
          index={-1}
          isPreamp
          onGainChange={setPreamp}
          isSelected={false}
          onSelect={() => setSelectedBandIndex(null)}
          canRemove={false}
        />

        <div className="eq-preamp-divider" />

        {/* Band sliders */}
        {bands.map((band, i) => (
          <EQBandSlider
            key={band.id}
            band={band}
            index={i}
            onGainChange={(gain) => updateBand(i, { gain })}
            onRemove={() => removeBand(i)}
            isSelected={selectedBandIndex === i}
            onSelect={() => setSelectedBandIndex(i)}
            canRemove={bands.length > 1}
          />
        ))}

        {/* Add band button */}
        {bands.length < 10 && (
          <button className="eq-add-band" onClick={() => addBand()} title="Add band">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
            </svg>
          </button>
        )}
      </div>

      {/* Band detail panel for precise editing */}
      {selectedBand && (
        <div className="eq-band-detail">
          <div className="eq-detail-field">
            <label className="eq-detail-label">Type</label>
            <select
              className="eq-detail-select"
              value={selectedBand.type}
              onChange={(e) => handleDetailChange('type', e.target.value)}
            >
              <option value="lowshelf">Low Shelf</option>
              <option value="peaking">Peaking</option>
              <option value="highshelf">High Shelf</option>
            </select>
          </div>

          <div className="eq-detail-field">
            <label className="eq-detail-label">Freq (Hz)</label>
            <NumericInput
              value={selectedBand.frequency}
              min={20}
              max={20000}
              step={1}
              onChange={(v) => handleDetailChange('frequency', v)}
            />
          </div>

          <div className="eq-detail-field">
            <label className="eq-detail-label">Gain (dB)</label>
            <NumericInput
              value={selectedBand.gain}
              min={-12}
              max={12}
              step={0.1}
              onChange={(v) => handleDetailChange('gain', v)}
            />
          </div>

          <div className="eq-detail-field">
            <label className="eq-detail-label">Q</label>
            <NumericInput
              value={selectedBand.Q}
              min={0.1}
              max={18}
              step={0.1}
              onChange={(v) => handleDetailChange('Q', v)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
