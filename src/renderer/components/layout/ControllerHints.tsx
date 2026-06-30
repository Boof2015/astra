import type { ControllerFamily } from '../../types/controller'
import { getControllerPromptLabels } from '../../utils/controllerGamepad'
import { useUIStore } from '../../stores/uiStore'

interface ControllerHintsProps {
  active: boolean
  family: ControllerFamily
  canOpenContext: boolean
  context: 'browsing' | 'now-playing'
}

export default function ControllerHints({ active, family, canOpenContext, context }: ControllerHintsProps) {
  const showQueue = useUIStore((state) => state.showQueue)
  if (!active) return null

  const labels = getControllerPromptLabels(family)
  return (
    <div className="controller-hints" aria-hidden="true">
      <span><kbd>{labels.activate}</kbd> Select</span>
      <span><kbd>{labels.back}</kbd> Back</span>
      {canOpenContext && <span><kbd>{labels.context}</kbd> More</span>}
      <span>
        <kbd>{labels.bumperLeft}</kbd><kbd>{labels.bumperRight}</kbd>
        {context === 'now-playing' ? ' Track' : ' Tabs'}
      </span>
      <span><kbd>{labels.queue}</kbd> {showQueue ? 'Close Queue' : 'Queue'}</span>
      <span><kbd>{labels.menu}</kbd> Play/Pause</span>
      <span><kbd>{labels.stickLeft}</kbd> Sidebar</span>
      <span><kbd>{labels.stickRight}</kbd> Now Playing</span>
    </div>
  )
}
