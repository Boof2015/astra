import type { ControllerFamily } from '../../types/controller'
import { useUIStore } from '../../stores/uiStore'
import ControllerGlyph from './ControllerGlyph'

interface ControllerHintsProps {
  active: boolean
  family: ControllerFamily
}

export default function ControllerHints({ active, family }: ControllerHintsProps) {
  const showQueue = useUIStore((state) => state.showQueue)
  if (!active) return null

  return (
    <div className="controller-hints" aria-hidden="true">
      <span><ControllerGlyph family={family} button="activate" /> Select</span>
      <span><ControllerGlyph family={family} button="back" /> Back</span>
      <span><ControllerGlyph family={family} button="playPause" /> Play/Pause</span>
      <span>
        <ControllerGlyph family={family} button="bumperLeft" />
        <ControllerGlyph family={family} button="bumperRight" />
        Track
      </span>
      <span>
        <ControllerGlyph family={family} button="triggerLeft" />
        <ControllerGlyph family={family} button="triggerRight" />
        Seek
      </span>
      <span><ControllerGlyph family={family} button="stickRight" /> <kbd>←/→</kbd> Tabs</span>
      <span><ControllerGlyph family={family} button="queue" /> {showQueue ? 'Close Queue' : 'Queue'}</span>
      <span><ControllerGlyph family={family} button="radialMenu" /> Wheel</span>
      <span><ControllerGlyph family={family} button="stickLeft" /> Sidebar</span>
      <span><ControllerGlyph family={family} button="stickRight" /> Now Playing</span>
    </div>
  )
}
