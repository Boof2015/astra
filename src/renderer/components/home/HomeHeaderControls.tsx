import SettingsSegmentedControl, { type SettingsSegmentedOption } from '../settings/SettingsSegmentedControl'
import { useUIStore, type HomeGreetingTextMode } from '../../stores/uiStore'

const HEADER_OPTIONS: readonly SettingsSegmentedOption<HomeGreetingTextMode>[] = [
  { value: 'messages', label: 'Messages' },
  { value: 'clock', label: 'Clock' },
  { value: 'binary-clock', label: 'Binary' },
  { value: 'off', label: 'Off' }
]

interface HomeHeaderControlsProps {
  compact?: boolean
}

export default function HomeHeaderControls({ compact = false }: HomeHeaderControlsProps) {
  const mode = useUIStore((state) => state.homeGreetingTextMode)
  const setMode = useUIStore((state) => state.setHomeGreetingTextMode)

  return (
    <SettingsSegmentedControl
      className={`home-header-controls${compact ? ' is-compact' : ''}`}
      ariaLabel="Home header display"
      fullWidth
      options={HEADER_OPTIONS}
      value={mode}
      onChange={setMode}
    />
  )
}
