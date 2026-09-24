import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePresence } from '../../hooks/usePresence'
import { filterHomeRecentTracks, type HomeRecentTrack } from '../../utils/homeRecentTracks'
import { HomeTrackRow } from './HomeMediaCards'
import type { HomePlaybackControlState } from './HomePlaybackControl'

export default function HomeRecentTracksDrawer({ isOpen, tracks, getPlayback, onPlay, onClose, error, onDismissError }: {
  isOpen: boolean
  tracks: readonly HomeRecentTrack[]
  getPlayback: (track: HomeRecentTrack) => HomePlaybackControlState
  onPlay: (track: HomeRecentTrack) => void
  onClose: () => void
  error: string | null
  onDismissError: () => void
}) {
  const presence = usePresence(isOpen)
  const headingId = useId()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [query, setQuery] = useState('')
  const filteredTracks = useMemo(() => filterHomeRecentTracks(tracks, query), [tracks, query])

  useLayoutEffect(() => {
    if (!presence.shouldRender) return
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // A native modal makes the underlying page inert and contains keyboard focus.
    dialog.showModal()
    searchRef.current?.focus()
    return () => {
      dialog.close()
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [presence.shouldRender])

  useLayoutEffect(() => {
    if (!isOpen) return
    setQuery('')
    if (listRef.current) listRef.current.scrollTop = 0
  }, [isOpen])

  if (!presence.shouldRender) return null

  return createPortal(
    <dialog ref={dialogRef} className="home-recent-drawer" data-presence={presence.phase}
      role="dialog" aria-modal="true" aria-labelledby={headingId} data-controller-scope="overlay"
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onKeyDown={(event) => {
        event.stopPropagation()
        // Search inputs consume Escape themselves; close consistently from any control.
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault()
          onClose()
        }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const bounds = event.currentTarget.getBoundingClientRect()
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
      }}>
      <header className="home-recent-drawer-header">
        <h2 id={headingId}>Recently played tracks</h2>
        <button type="button" className="home-section-action" onClick={onClose} aria-label="Close recent tracks" data-controller-back="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <div className="home-recent-search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
        <input ref={searchRef} type="search" value={query} aria-label="Search recent tracks" placeholder="Search tracks, artists, or albums"
          onChange={(event) => { setQuery(event.target.value); if (listRef.current) listRef.current.scrollTop = 0 }} />
        {query && <button type="button" className="home-section-action" aria-label="Clear recent track search" onClick={() => {
          setQuery('')
          if (listRef.current) listRef.current.scrollTop = 0
          searchRef.current?.focus()
        }}>Clear</button>}
      </div>
      <p className="home-recent-count" role="status">{query.trim() ? `${filteredTracks.length} of ${tracks.length} tracks` : `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}`}</p>
      {error && <div className="home-recent-error" role="alert"><span>{error}</span><button type="button" className="home-section-action" onClick={onDismissError}>Dismiss</button></div>}
      <div ref={listRef} className="home-recent-drawer-list" data-controller-scroll data-controller-group="home-recent-drawer-tracks" data-controller-axis="vertical">
        {filteredTracks.length ? filteredTracks.map((track) => (
          <HomeTrackRow key={track.path} title={track.title} subtitle={track.artist} artworkHash={track.artwork_hash}
            playback={getPlayback(track)} onPlay={() => onPlay(track)} />
        )) : <p className="home-recent-empty">{tracks.length ? 'No tracks match your search.' : 'Your recently played tracks will appear here.'}</p>}
      </div>
    </dialog>,
    document.body
  )
}
