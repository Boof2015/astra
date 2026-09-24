import type { MouseEventHandler, ReactNode } from 'react'
import HomeArtwork from './HomeArtwork'
import HomePlaybackControl, { HomePlaybackGlyph, homePlaybackLabel, type HomePlaybackControlState } from './HomePlaybackControl'

interface HomeMediaProps {
  title: string
  subtitle: ReactNode
  artworkHash: string | null
  playback: HomePlaybackControlState
  onPlay: () => void
}

export function HomeCollectionCard({ title, subtitle, artworkHash, playback, onPlay, onOpen, playlist, favorites, onContextMenu, hoverPlayback = false }: HomeMediaProps & {
  onOpen: () => void
  playlist?: boolean
  favorites?: boolean
  onContextMenu?: MouseEventHandler<HTMLElement>
  hoverPlayback?: boolean
}) {
  return (
    <article className={`home-collection-card${hoverPlayback ? ' home-hover-playback' : ''}${playback.playing || playback.pending ? ' has-playback-indicator' : ''}`} onContextMenu={onContextMenu}>
      <button type="button" className="home-media-open" onClick={onOpen} aria-label={`Open ${title}`} title={title}
        data-controller-focusable="true" data-controller-context="true">
        <HomeArtwork hash={artworkHash} title={title} playlist={playlist} favorites={favorites} />
        <span className="home-media-copy"><strong className="home-media-title">{title}</strong><span className="home-media-subtitle">{subtitle}</span></span>
      </button>
      {hoverPlayback ? (
        <span className="home-floating-playback"><HomePlaybackControl title={title} state={playback} onPlay={onPlay} /></span>
      ) : <HomePlaybackControl title={title} state={playback} onPlay={onPlay} />}
    </article>
  )
}

export function HomeAlbumCard({ title, subtitle, artworkHash, playback, onPlay, onOpen, reason }: Omit<HomeMediaProps, 'subtitle'> & {
  subtitle: string
  onOpen: () => void
  reason: string
}) {
  return (
    <article className="home-media-album">
      <button type="button" className="home-media-open" onClick={onOpen} aria-label={`Open ${title} by ${subtitle}`} title={title}
        data-controller-focusable="true" data-controller-context="true">
        <HomeArtwork hash={artworkHash} title={title} />
        <span className="home-media-copy"><strong className="home-media-title">{title}</strong><span className="home-media-subtitle">{subtitle}</span></span>
      </button>
      <div className="home-album-footer">
        <span className="home-media-context" title={reason}>{reason}</span>
        <HomePlaybackControl title={title} state={playback} onPlay={onPlay} />
      </div>
    </article>
  )
}

export function HomeTrackRow({ title, subtitle, artworkHash, playback, onPlay }: Omit<HomeMediaProps, 'subtitle'> & { subtitle: string }) {
  const label = homePlaybackLabel(`${title} by ${subtitle}`, playback)
  return (
    <button type="button" className={`home-track-row home-hover-playback${playback.playing || playback.pending ? ' has-playback-indicator' : ''}`} onClick={onPlay} disabled={playback.disabled}
      aria-label={label} aria-busy={playback.pending} title={`${title} — ${subtitle}`} data-controller-focusable={playback.disabled ? undefined : 'true'}>
      <HomeArtwork hash={artworkHash} title={title} />
      <span className="home-media-copy"><strong className="home-media-title">{title}</strong><span className="home-media-subtitle">{subtitle}</span></span>
      <span className="home-floating-playback"><HomePlaybackGlyph state={playback} /></span>
    </button>
  )
}
