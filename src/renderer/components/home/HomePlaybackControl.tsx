export interface HomePlaybackControlState {
  active: boolean
  playing: boolean
  pending: boolean
  disabled: boolean
}

export function homePlaybackLabel(title: string, state: HomePlaybackControlState): string {
  return `${state.pending ? 'Starting' : state.playing ? 'Pause' : state.active ? 'Continue' : 'Play'} ${title}`
}

/** Also used inside a track's single button, without nesting interactive elements. */
export function HomePlaybackGlyph({ state }: { state: HomePlaybackControlState }) {
  return (
    <span className={`home-playback-glyph${state.playing ? ' is-playing' : ''}${state.pending ? ' is-pending' : ''}`} aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d={state.pending ? 'M6 10h2v4H6zm5 0h2v4h-2zm5 0h2v4h-2z' : state.playing ? 'M6 5h4v14H6zm8 0h4v14h-4z' : 'M8 5v14l11-7z'} />
      </svg>
    </span>
  )
}

export default function HomePlaybackControl({ title, state, onPlay }: {
  title: string
  state: HomePlaybackControlState
  onPlay: () => void
}) {
  const label = homePlaybackLabel(title, state)
  return (
    <button type="button" className="home-playback-control" onClick={onPlay} disabled={state.disabled}
      aria-label={label} aria-busy={state.pending} title={label} data-controller-focusable={state.disabled ? undefined : 'true'}>
      <HomePlaybackGlyph state={state} />
    </button>
  )
}
