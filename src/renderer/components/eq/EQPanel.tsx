import { useState, useCallback, useRef, useEffect } from 'react'
import { useEQStore } from '../../stores/eqStore'
import { useUIStore } from '../../stores/uiStore'
import { audioEngine } from '../../audio/AudioEngine'
import { EQBand } from '../../types/audio'
import EQFrequencyResponse from './EQFrequencyResponse'
import EQSpectrumOverlay from './EQSpectrumOverlay'
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
    saveCustomPreset,
    deleteCustomPreset,
    exportPreset,
    importFromFile,
    importAutoEQ,
  } = useEQStore()

  const [selectedBandIndex, setSelectedBandIndex] = useState<number | null>(null)
  const [showSaveInput, setShowSaveInput] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [showImportMenu, setShowImportMenu] = useState(false)
  const importMenuRef = useRef<HTMLDivElement>(null)
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

  // Close import menu on outside click
  useEffect(() => {
    if (!showImportMenu) return
    const handleClick = (e: MouseEvent) => {
      if (importMenuRef.current && !importMenuRef.current.contains(e.target as Node)) {
        setShowImportMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showImportMenu])

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

  const activePreset = activePresetId ? presets.find((p) => p.id === activePresetId) : null
  const builtInPresets = presets.filter((p) => !p.isCustom)
  const customPresets = presets.filter((p) => p.isCustom)

  const handleSave = () => {
    if (saveName.trim()) {
      saveCustomPreset(saveName.trim())
    }
    setShowSaveInput(false)
    setSaveName('')
  }

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
            <optgroup label="Built-in">
              {builtInPresets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
            {customPresets.length > 0 && (
              <optgroup label="My Presets">
                {customPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>

          {/* Save preset */}
          {showSaveInput ? (
            <div className="eq-save-inline">
              <input
                className="eq-save-name-input"
                type="text"
                placeholder="Preset name..."
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSave()
                  else if (e.key === 'Escape') {
                    setShowSaveInput(false)
                    setSaveName('')
                  }
                }}
                autoFocus
              />
              <button
                className="eq-reset-btn"
                onClick={handleSave}
                title="Confirm save"
                disabled={!saveName.trim()}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                </svg>
              </button>
            </div>
          ) : (
            <button
              className="eq-reset-btn"
              onClick={() => setShowSaveInput(true)}
              title="Save as preset"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z" />
              </svg>
            </button>
          )}

          {/* Delete custom preset */}
          {activePreset?.isCustom && (
            <button
              className="eq-reset-btn"
              onClick={() => deleteCustomPreset(activePresetId!)}
              title="Delete this preset"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
              </svg>
            </button>
          )}

          {/* Import/Export menu */}
          <div className="eq-import-wrapper" ref={importMenuRef}>
            <button
              className="eq-reset-btn"
              onClick={() => setShowImportMenu(!showImportMenu)}
              title="Import / Export"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
              </svg>
            </button>
            {showImportMenu && (
              <div className="eq-import-menu">
                <button onClick={() => { importFromFile(); setShowImportMenu(false) }}>
                  Import Preset
                </button>
                <button onClick={() => { importAutoEQ(); setShowImportMenu(false) }}>
                  Import AutoEQ
                </button>
                {activePresetId && (
                  <button onClick={() => { exportPreset(activePresetId); setShowImportMenu(false) }}>
                    Export Current
                  </button>
                )}
              </div>
            )}
          </div>

          <button className="eq-reset-btn" onClick={resetEQ} title="Reset EQ">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
            </svg>
          </button>

          <button
            className="eq-close-btn"
            onClick={() => useUIStore.getState().setActiveView('library')}
            title="Close EQ"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Frequency response curve + spectrum overlay */}
      <div className="eq-response-area" ref={responseAreaRef}>
        <EQSpectrumOverlay
          width={responseDims.width}
          height={responseDims.height}
        />
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
