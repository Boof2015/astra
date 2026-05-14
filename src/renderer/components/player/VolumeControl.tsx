import type { PointerEvent, ReactElement, WheelEvent } from 'react'
import {
  BIT_PERFECT_DSP_DISABLED_MESSAGE,
  useAudioSettingsStore
} from '../../stores/audioSettingsStore'
import { usePlayerStore } from '../../stores/playerStore'

const WHEEL_VOLUME_STEP = 0.01

interface VolumeControlProps {
  className: string
  labelFormatter?: (percent: number) => string
}

function getPercentFromClientX(clientX: number, element: HTMLDivElement): number {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0) return 0
  const percent = (clientX - rect.left) / rect.width
  return Math.max(0, Math.min(1, percent))
}

function clampVolumePercent(volume: number): number {
  return Math.max(0, Math.min(1, volume))
}

function VolumeIcon({
  isMuted,
  volume
}: {
  isMuted: boolean
  volume: number
}): ReactElement {
  if (isMuted || volume === 0) {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
      </svg>
    )
  }

  if (volume < 0.5) {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M7 9v6h4l5 5V4l-5 5H7z" />
      </svg>
    )
  }

  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
    </svg>
  )
}

export default function VolumeControl({
  className,
  labelFormatter = (percent) => String(percent)
}: VolumeControlProps): ReactElement {
  const volume = usePlayerStore((s) => s.volume)
  const isMuted = usePlayerStore((s) => s.isMuted)
  const setVolume = usePlayerStore((s) => s.setVolume)
  const toggleMute = usePlayerStore((s) => s.toggleMute)
  const playbackOutputMode = useAudioSettingsStore((s) => s.playbackOutputMode)
  const playbackModeStatusMessage = useAudioSettingsStore((s) => s.playbackModeStatusMessage)

  const volumeControlDisabled = playbackOutputMode === 'bitperfect'
  const disabledControlMessage = playbackModeStatusMessage ?? BIT_PERFECT_DSP_DISABLED_MESSAGE
  const effectiveVolume = isMuted ? 0 : volume
  const visiblePercent = Math.round(effectiveVolume * 100)
  const controlTitle = volumeControlDisabled ? disabledControlMessage : 'Playback volume'

  const handleVolumePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (volumeControlDisabled) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setVolume(getPercentFromClientX(event.clientX, event.currentTarget))
  }

  const handleVolumePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (volumeControlDisabled) return
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    setVolume(getPercentFromClientX(event.clientX, event.currentTarget))
  }

  const releaseVolumePointer = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleVolumeWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (volumeControlDisabled) return
    if (event.deltaY === 0) return

    event.preventDefault()
    const direction = event.deltaY < 0 ? 1 : -1
    setVolume(clampVolumePercent(volume + (direction * WHEEL_VOLUME_STEP)))
  }

  return (
    <div className={className}>
      <button
        type="button"
        className="volume-btn"
        onClick={volumeControlDisabled ? undefined : toggleMute}
        aria-label={isMuted ? 'Unmute' : 'Mute'}
        title={volumeControlDisabled ? disabledControlMessage : (isMuted ? 'Unmute' : 'Mute')}
        disabled={volumeControlDisabled}
      >
        <VolumeIcon isMuted={isMuted} volume={volume} />
      </button>
      <div
        className={`volume-slider${volumeControlDisabled ? ' disabled' : ''}`}
        onPointerDown={handleVolumePointerDown}
        onPointerMove={handleVolumePointerMove}
        onPointerUp={releaseVolumePointer}
        onPointerCancel={releaseVolumePointer}
        onWheel={handleVolumeWheel}
        role="slider"
        aria-label="Playback volume"
        aria-valuenow={visiblePercent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${visiblePercent}%`}
        aria-disabled={volumeControlDisabled}
        title={controlTitle}
      >
        <div
          className="volume-fill"
          style={{ width: `${effectiveVolume * 100}%` }}
        />
      </div>
      <span className="volume-label">{labelFormatter(visiblePercent)}</span>
    </div>
  )
}
