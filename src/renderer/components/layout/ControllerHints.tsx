import LocalizedText from '../i18n/LocalizedText'
import { translate } from '../../i18n'
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
      <span><ControllerGlyph family={family} button="activate" />  <LocalizedText ns="common" i18nKey="auto.controllerhints.select" /></span>
      <span><ControllerGlyph family={family} button="back" />  <LocalizedText ns="common" i18nKey="auto.controllerhints.back" /></span>
      <span><ControllerGlyph family={family} button="playPause" />  <LocalizedText ns="common" i18nKey="auto.controllerhints.play_pause" /></span>
      <span>
        <ControllerGlyph family={family} button="bumperLeft" />
        <ControllerGlyph family={family} button="bumperRight" />

        <LocalizedText ns="common" i18nKey="auto.controllerhints.track" />
      </span>
      <span>
        <ControllerGlyph family={family} button="triggerLeft" />
        <ControllerGlyph family={family} button="triggerRight" />

        <LocalizedText ns="common" i18nKey="auto.controllerhints.seek" />
      </span>
      <span><ControllerGlyph family={family} button="stickRight" /> <kbd>←/→</kbd>  <LocalizedText ns="common" i18nKey="auto.controllerhints.tabs" /></span>
      <span><ControllerGlyph family={family} button="queue" /> {showQueue ? translate('common:auto.controllerhints.close_queue') : translate('common:auto.controllerhints.queue')}</span>
      <span><ControllerGlyph family={family} button="radialMenu" />  <LocalizedText ns="common" i18nKey="auto.controllerhints.wheel" /></span>
      <span><ControllerGlyph family={family} button="stickLeft" />  <LocalizedText ns="common" i18nKey="auto.controllerhints.sidebar" /></span>
      <span><ControllerGlyph family={family} button="stickRight" />  <LocalizedText ns="common" i18nKey="auto.controllerhints.now_playing" /></span>
    </div>
  )
}
