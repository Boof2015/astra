import SettingsSegmentedControl from '../settings/SettingsSegmentedControl'
import { useUIStore } from '../../stores/uiStore'
import {
  HOME_SKY_TIME_MAX_MINUTES,
  HOME_SKY_TIME_STEP_MINUTES,
  formatHomeSkyTime,
  type HomeSkyTimeMode
} from '../../utils/homePreferences'

const SKY_MODE_OPTIONS: ReadonlyArray<{ value: HomeSkyTimeMode; label: string }> = [
  { value: 'realtime', label: 'Follow Local Time' },
  { value: 'fixed', label: 'Fixed Time' }
]

interface HomeSkyControlsProps {
  compact?: boolean
}

export default function HomeSkyControls({ compact = false }: HomeSkyControlsProps) {
  const preference = useUIStore((state) => state.homeSkyTimePreference)
  const setMode = useUIStore((state) => state.setHomeSkyTimeMode)
  const setFixedMinutes = useUIStore((state) => state.setHomeSkyFixedMinutes)
  const fixedMinutes = preference.fixedMinutes ?? 0

  return (
    <div className={`home-sky-controls${compact ? ' is-compact' : ''}`}>
      <div className="home-sky-control-field">
        <span className="settings-field-label">Sky Time</span>
        <SettingsSegmentedControl
          ariaLabel="Home sky time mode"
          fullWidth
          options={SKY_MODE_OPTIONS}
          value={preference.mode}
          onChange={setMode}
        />
      </div>
      {preference.mode === 'fixed' && (
        <label className="home-sky-control-field home-sky-time-slider-field">
          <span className="settings-field-label">Displayed Time</span>
          <div className="home-sky-time-slider-row">
            <input
              className="home-sky-time-slider"
              type="range"
              min={0}
              max={HOME_SKY_TIME_MAX_MINUTES}
              step={HOME_SKY_TIME_STEP_MINUTES}
              value={fixedMinutes}
              onChange={(event) => setFixedMinutes(Number(event.target.value))}
              aria-label="Fixed Home sky time"
              aria-valuetext={formatHomeSkyTime(fixedMinutes)}
            />
            <output className="home-sky-time-value">{formatHomeSkyTime(fixedMinutes)}</output>
          </div>
          <span className="home-sky-time-hint">Messages and the clock still use your real local time.</span>
        </label>
      )}
    </div>
  )
}
