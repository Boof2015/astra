import type { ControllerFamily } from '../../types/controller'
import { getControllerPromptLabels } from '../../utils/controllerGamepad'
import { useUIStore } from '../../stores/uiStore'

interface ControllerHintsProps {
  active: boolean
  family: ControllerFamily
}

export default function ControllerHints({ active, family }: ControllerHintsProps) {
  const showQueue = useUIStore((state) => state.showQueue)
  if (!active) return null

  const labels = getControllerPromptLabels(family)
  return (
    <div className="controller-hints" aria-hidden="true">
      <span><kbd>{labels.activate}</kbd> Select</span>
      <span><kbd>{labels.back}</kbd> Back</span>
      <span><kbd>{labels.playPause}</kbd> Play/Pause</span>
      <span>
        <kbd>{labels.bumperLeft}</kbd><kbd>{labels.bumperRight}</kbd>
        Track
      </span>
      <span>
        <kbd>{labels.triggerLeft}</kbd><kbd>{labels.triggerRight}</kbd>
        Seek
      </span>
      <span><kbd>RS ←/→</kbd> Tabs</span>
      <span><kbd>{labels.queue}</kbd> {showQueue ? 'Close Queue' : 'Queue'}</span>
      <span><kbd>{labels.radialMenu}</kbd> Wheel</span>
      <span><kbd>{labels.stickLeft}</kbd> Sidebar</span>
      <span><kbd>{labels.stickRight}</kbd> Now Playing</span>
    </div>
  )
}
