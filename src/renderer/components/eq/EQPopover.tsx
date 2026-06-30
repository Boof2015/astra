import { useEQStore } from '../../stores/eqStore'
import { useUIStore } from '../../stores/uiStore'
import EQResponsePreview from './EQResponsePreview'

import type { PresencePhase } from '../../hooks/usePresence'

interface EQPopoverProps {
  onClose: () => void
  presencePhase: PresencePhase
}

export default function EQPopover({ onClose, presencePhase }: EQPopoverProps) {
  const { enabled, toggleEnabled, presets, activePresetId, applyPreset } = useEQStore()
  const setActiveView = useUIStore((s) => s.setActiveView)

  const activePreset = activePresetId ? presets.find((p) => p.id === activePresetId) : null

  return (
    <div className="eq-popover" data-presence={presencePhase} aria-hidden={presencePhase === 'exiting'}>
      <div className="eq-popover-header">
        <span className="eq-popover-title">EQ PREVIEW</span>
        <div className="eq-popover-actions">
          <div
            className={`eq-toggle-switch ${enabled ? 'active' : ''}`}
            onClick={toggleEnabled}
            role="switch"
            aria-checked={enabled}
            title={enabled ? 'Disable EQ' : 'Enable EQ'}
          />
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
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button
            className="eq-popover-open-full"
            onClick={() => {
              setActiveView('eq')
              onClose()
            }}
          >
            OPEN FULL EQ
          </button>
          <button className="eq-popover-close" onClick={onClose} title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>
      </div>
      <div className="eq-popover-preview">
        <EQResponsePreview className="eq-popover-preview-curve" width={420} height={118} />
      </div>
      <div className="eq-popover-status">
        <span className="eq-popover-preset-name">
          {activePreset ? activePreset.name : 'Custom'}
        </span>
        <span className={`eq-popover-state ${enabled ? 'enabled' : ''}`}>
          {enabled ? 'ON' : 'OFF'}
        </span>
      </div>
    </div>
  )
}
