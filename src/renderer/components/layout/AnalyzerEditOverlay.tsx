import { useEffect, useMemo, useState, type CSSProperties, type DragEvent } from 'react'
import type { ScopeKind } from '../../../types/scopePopout'
import {
  useVisualizerSettingsStore,
  type AnalyzerProfile,
  type FFTSize,
} from '../../stores/visualizerSettingsStore'
import { useUIStore } from '../../stores/uiStore'

const FFT_OPTIONS: readonly FFTSize[] = [1024, 2048, 4096, 8192, 16384]

interface AnalyzerEditOverlayProps {
  hiddenScopes: ScopeKind[]
  draggedScope: ScopeKind | null
  isDraggingFromHidden: boolean
  isHiddenDropActive: boolean
  onHiddenScopeDragStart: (scope: ScopeKind, event: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onHiddenDragOver: (event: DragEvent<HTMLDivElement>) => void
  onHiddenDrop: (event: DragEvent<HTMLDivElement>) => void
}

function scopeLabel(scope: ScopeKind): string {
  switch (scope) {
    case 'spectrum':
      return 'Spectrum'
    case 'oscilloscope':
      return 'Oscilloscope'
    case 'vectorscope':
      return 'Vectorscope'
  }
}

function scopeStateLabel(
  scope: ScopeKind,
  fftSize: FFTSize,
  pitchLock: boolean,
  underfillEnabled: boolean
): string {
  switch (scope) {
    case 'spectrum':
      return `FFT ${fftSize}`
    case 'oscilloscope':
      return pitchLock
        ? underfillEnabled ? 'Pitch-lock + underfill' : 'Pitch-lock'
        : underfillEnabled ? 'Free-run + underfill' : 'Free-run'
    case 'vectorscope':
      return 'Stereo image'
  }
}

function sortProfiles(profiles: Record<string, AnalyzerProfile>) {
  return Object.values(profiles).sort((left, right) => left.name.localeCompare(right.name))
}

function stashStyle(scope: ScopeKind): CSSProperties {
  switch (scope) {
    case 'spectrum':
      return {
        top: '12%',
        left: '5%',
        transform: 'rotate(-4deg)',
      }
    case 'oscilloscope':
      return {
        top: '16%',
        right: '7%',
        transform: 'rotate(3deg)',
      }
    case 'vectorscope':
      return {
        bottom: '16%',
        left: '16%',
        transform: 'rotate(-2deg)',
      }
  }
}

function ScopeGhost({ scope }: { scope: ScopeKind }) {
  switch (scope) {
    case 'spectrum':
      return (
        <svg viewBox="0 0 144 80" aria-hidden="true">
          <path d="M10 65 L28 50 L42 56 L58 34 L74 42 L90 18 L106 28 L132 10" />
          <path d="M10 70 H134" className="muted" />
          <path d="M24 70 V44 M48 70 V30 M72 70 V25 M96 70 V16" className="muted" />
        </svg>
      )
    case 'oscilloscope':
      return (
        <svg viewBox="0 0 144 80" aria-hidden="true">
          <path d="M10 40 C22 40 24 18 36 18 S50 62 62 62 S76 24 88 24 S102 56 114 56 S126 40 134 40" />
          <path d="M10 40 H134" className="muted" />
        </svg>
      )
    case 'vectorscope':
      return (
        <svg viewBox="0 0 144 80" aria-hidden="true">
          <circle cx="72" cy="40" r="26" />
          <path d="M72 14 V66 M46 40 H98" className="muted" />
          <path d="M54 58 L90 22" />
        </svg>
      )
  }
}

export default function AnalyzerEditOverlay({
  hiddenScopes,
  draggedScope,
  isDraggingFromHidden,
  isHiddenDropActive,
  onHiddenScopeDragStart,
  onDragEnd,
  onHiddenDragOver,
  onHiddenDrop,
}: AnalyzerEditOverlayProps) {
  const profiles = useVisualizerSettingsStore((state) => state.profiles)
  const activeProfileId = useVisualizerSettingsStore((state) => state.activeProfileId)
  const activeProfileName = useVisualizerSettingsStore((state) => state.activeProfileName)
  const activeProfileBuiltIn = useVisualizerSettingsStore((state) => state.activeProfileBuiltIn)
  const activeProfileCanDelete = useVisualizerSettingsStore((state) => state.activeProfileCanDelete)
  const fftSize = useVisualizerSettingsStore((state) => state.fftSize)
  const pitchLock = useVisualizerSettingsStore((state) => state.pitchLock)
  const oscilloscopeUnderfillEnabled = useVisualizerSettingsStore((state) => state.oscilloscopeUnderfillEnabled)
  const setActiveProfile = useVisualizerSettingsStore((state) => state.setActiveProfile)
  const saveCurrentProfile = useVisualizerSettingsStore((state) => state.saveCurrentProfile)
  const deleteProfile = useVisualizerSettingsStore((state) => state.deleteProfile)
  const setFftSize = useVisualizerSettingsStore((state) => state.setFftSize)
  const setPitchLock = useVisualizerSettingsStore((state) => state.setPitchLock)
  const setOscilloscopeUnderfillEnabled = useVisualizerSettingsStore((state) => state.setOscilloscopeUnderfillEnabled)

  const closeAnalyzerEditMode = useUIStore((state) => state.closeAnalyzerEditMode)
  const setActiveView = useUIStore((state) => state.setActiveView)
  const setPendingSettingsSection = useUIStore((state) => state.setPendingSettingsSection)

  const [showSaveInput, setShowSaveInput] = useState(false)
  const [saveName, setSaveName] = useState('')

  useEffect(() => {
    setShowSaveInput(false)
    setSaveName('')
  }, [activeProfileId])

  const sortedProfiles = useMemo(() => sortProfiles(profiles), [profiles])
  const builtInProfiles = useMemo(
    () => sortedProfiles.filter((profile) => profile.builtIn),
    [sortedProfiles]
  )
  const userProfiles = useMemo(
    () => sortedProfiles.filter((profile) => !profile.builtIn),
    [sortedProfiles]
  )
  const showHiddenDropField = draggedScope !== null && !isDraggingFromHidden
  const activeBadgeLabel = activeProfileId === null
    ? 'Custom'
    : activeProfileBuiltIn
      ? 'Built-in'
      : 'Saved'

  const handleSave = () => {
    const trimmed = saveName.trim()
    if (!trimmed) return
    saveCurrentProfile(trimmed)
    setShowSaveInput(false)
    setSaveName('')
  }

  const openAnalyzerSettings = () => {
    closeAnalyzerEditMode()
    setActiveView('settings')
    setPendingSettingsSection('analyzer')
  }

  return (
    <div className="analyzer-edit-overlay-backdrop">
      {showHiddenDropField && (
        <div
          className={`analyzer-edit-stash-dropfield ${isHiddenDropActive ? 'is-active' : ''}`.trim()}
          onDragOver={onHiddenDragOver}
          onDrop={onHiddenDrop}
        >
          <div className="analyzer-edit-stash-dropfield-label">Drop here to stash the scope</div>
        </div>
      )}

      <div className="analyzer-edit-corner analyzer-edit-corner-top-left">
        <div className="analyzer-edit-corner-group">
          <div className="analyzer-edit-corner-label">PROFILE</div>
          <select
            className="analyzer-edit-select"
            value={activeProfileId ?? ''}
            onChange={(event) => {
              if (event.target.value) {
                setActiveProfile(event.target.value)
              }
            }}
          >
            <option value="">Custom</option>
            <optgroup label="Built-in">
              {builtInProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </optgroup>
            {userProfiles.length > 0 && (
              <optgroup label="My Profiles">
                {userProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        {showSaveInput ? (
          <div className="analyzer-edit-save-inline">
            <input
              type="text"
              className="analyzer-edit-input"
              value={saveName}
              placeholder="Profile name..."
              onChange={(event) => setSaveName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  handleSave()
                } else if (event.key === 'Escape') {
                  setShowSaveInput(false)
                  setSaveName('')
                }
              }}
              autoFocus
            />
            <button
              type="button"
              className="analyzer-edit-button analyzer-edit-button-primary"
              disabled={saveName.trim().length === 0}
              onClick={handleSave}
            >
              Save
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="analyzer-edit-button"
            onClick={() => setShowSaveInput(true)}
          >
            Save
          </button>
        )}

        {activeProfileCanDelete && activeProfileId && (
          <button
            type="button"
            className="analyzer-edit-button"
            onClick={() => deleteProfile(activeProfileId)}
          >
            Delete
          </button>
        )}

        <div className={`analyzer-edit-badge ${activeProfileId === null ? 'is-accent' : ''}`.trim()}>
          {activeBadgeLabel}: {activeProfileName}
        </div>
      </div>

      <div className="analyzer-edit-corner analyzer-edit-corner-top-right">
        <button
          type="button"
          className="analyzer-edit-button"
          onClick={openAnalyzerSettings}
        >
          Settings
        </button>
        <button
          type="button"
          className="analyzer-edit-button analyzer-edit-button-primary"
          onClick={closeAnalyzerEditMode}
        >
          Done
        </button>
      </div>

      <div className="analyzer-edit-corner analyzer-edit-corner-bottom-left">
        <div className="analyzer-edit-help">
          <div className="analyzer-edit-corner-label">EDIT MODE</div>
          <div className="analyzer-edit-help-copy">
            Drag the real scopes in the rack to reorder them.
            <br />
            Drag one out into the blurred field to stash it.
            <br />
            Drag the seams between scopes to resize them.
          </div>
        </div>
      </div>

      <div className="analyzer-edit-corner analyzer-edit-corner-bottom-right">
        <div className="analyzer-edit-mini-control">
          <span className="analyzer-edit-corner-label">FFT</span>
          <select
            className="analyzer-edit-select analyzer-edit-select-compact"
            value={fftSize}
            onChange={(event) => setFftSize(Number(event.target.value) as FFTSize)}
          >
            {FFT_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          className={`analyzer-edit-button ${pitchLock ? 'is-active' : ''}`.trim()}
          onClick={() => setPitchLock(!pitchLock)}
        >
          Pitch {pitchLock ? 'On' : 'Off'}
        </button>

        <button
          type="button"
          className={`analyzer-edit-button ${oscilloscopeUnderfillEnabled ? 'is-active' : ''}`.trim()}
          onClick={() => setOscilloscopeUnderfillEnabled(!oscilloscopeUnderfillEnabled)}
        >
          Fill {oscilloscopeUnderfillEnabled ? 'On' : 'Off'}
        </button>
      </div>

      {hiddenScopes.length === 0 ? (
        <div className="analyzer-edit-empty-hint">
          Nothing is stashed right now.
        </div>
      ) : (
        hiddenScopes.map((scope) => (
          <div
            key={scope}
            className={`analyzer-edit-stash-scope ${draggedScope === scope ? 'is-dragging' : ''}`.trim()}
            style={stashStyle(scope)}
            draggable
            onDragStart={(event) => onHiddenScopeDragStart(scope, event)}
            onDragEnd={onDragEnd}
          >
            <div className="analyzer-edit-stash-header">
              <span>{scopeLabel(scope).toUpperCase()}</span>
              <span>STASHED</span>
            </div>
            <div className="analyzer-edit-stash-preview">
              <ScopeGhost scope={scope} />
            </div>
            <div className="analyzer-edit-stash-meta">
              {scopeStateLabel(scope, fftSize, pitchLock, oscilloscopeUnderfillEnabled)}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
