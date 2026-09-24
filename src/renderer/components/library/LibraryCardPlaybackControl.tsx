import { HomePlaybackGlyph, homePlaybackLabel, type HomePlaybackControlState } from '../home/HomePlaybackControl'

export default function LibraryCardPlaybackControl({ title, state, onPlay, controllerKey, controllerIndex, contextMenu = false, className = '' }: {
  title: string
  state: HomePlaybackControlState
  onPlay: () => void
  controllerKey: string
  controllerIndex?: number
  contextMenu?: boolean
  className?: string
}) {
  const label = homePlaybackLabel(title, state)
  return (
    <button
      type="button"
      className={`library-card-playback home-playback-control ${className}`}
      // Native disabled drops keyboard focus during an async playback request.
      aria-disabled={state.disabled}
      tabIndex={state.disabled ? -1 : 0}
      aria-label={label}
      aria-busy={state.pending}
      title={label}
      data-controller-exclude={state.disabled ? 'true' : undefined}
      data-controller-focusable={state.disabled ? undefined : 'true'}
      data-controller-context={contextMenu ? 'true' : undefined}
      data-controller-key={`${controllerKey}:play`}
      data-controller-index={controllerIndex}
      data-controller-action="play"
      onClick={() => { if (!state.disabled) onPlay() }}
    >
      <HomePlaybackGlyph state={state} />
    </button>
  )
}
