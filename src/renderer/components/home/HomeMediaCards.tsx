import type { MouseEventHandler, ReactNode } from 'react'
import HomeArtwork from './HomeArtwork'
import HomePlaybackControl, { HomePlaybackGlyph, homePlaybackLabel, type HomePlaybackControlState } from './HomePlaybackControl'
import HoverRevealText from '../common/HoverRevealText'
import { useHoverRevealCard } from '../../hooks/useHoverRevealCard'

interface HomeMediaProps {
  title: string
  subtitle: ReactNode
  artworkHash: string | null
  playback: HomePlaybackControlState
  onPlay: () => void
}

export function HomeCollectionCard({ title, subtitle, artworkHash, playback, onPlay, onOpen, playlist, favorites, onContextMenu, hoverPlayback = false, revealTitle = false, revealSubtitle, subtitleDetail }: HomeMediaProps & {
  onOpen: () => void
  playlist?: boolean
  favorites?: boolean
  onContextMenu?: MouseEventHandler<HTMLElement>
  hoverPlayback?: boolean
  revealTitle?: boolean
  revealSubtitle?: string
  subtitleDetail?: string
}) {
  const revealEnabled = revealTitle || revealSubtitle !== undefined
  const reveal = useHoverRevealCard(`${title}:${revealSubtitle ?? ''}`, revealEnabled)
  return (
    <article {...reveal.cardProps} className={`home-collection-card${hoverPlayback ? ' home-hover-playback' : ''}${playback.playing || playback.pending ? ' has-playback-indicator' : ''}`} onContextMenu={onContextMenu}>
      <button type="button" className="home-media-open" onClick={onOpen} aria-label={`Open ${title}${revealSubtitle ? ` by ${revealSubtitle}` : ''}`}
        title={!revealEnabled || reveal.reducedMotion ? `${title}${revealSubtitle ? ` — ${revealSubtitle}` : ''}` : undefined}
        data-controller-focusable="true" data-controller-context="true">
        <HomeArtwork hash={artworkHash} title={title} playlist={playlist} favorites={favorites} />
        <span className="home-media-copy">
          {revealTitle
            ? <HoverRevealText className="home-media-title" text={title} {...reveal.textProps} />
            : <strong className="home-media-title">{title}</strong>}
          {revealSubtitle !== undefined || subtitleDetail !== undefined ? (
            <span className="home-media-subtitle home-media-subtitle--with-detail">
              {revealSubtitle !== undefined
                ? <HoverRevealText text={revealSubtitle} {...reveal.textProps} />
                : <span className="home-media-subtitle-label">{subtitle}</span>}
              {subtitleDetail && <span className="home-media-subtitle-detail">· {subtitleDetail}</span>}
            </span>
          ) : <span className="home-media-subtitle">{subtitle}</span>}
        </span>
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
  const reveal = useHoverRevealCard(`${title}:${subtitle}`)
  return (
    <article {...reveal.cardProps} className="home-media-album">
      <button type="button" className="home-media-open" onClick={onOpen} aria-label={`Open ${title} by ${subtitle}`} title={reveal.reducedMotion ? `${title} — ${subtitle}` : undefined}
        data-controller-focusable="true" data-controller-context="true">
        <HomeArtwork hash={artworkHash} title={title} />
        <span className="home-media-copy">
          <HoverRevealText className="home-media-title" text={title} {...reveal.textProps} />
          <HoverRevealText className="home-media-subtitle" text={subtitle} {...reveal.textProps} />
        </span>
      </button>
      <div className="home-album-footer">
        <span className="home-media-context" title={reason}>{reason}</span>
        <HomePlaybackControl title={title} state={playback} onPlay={onPlay} />
      </div>
    </article>
  )
}

export function HomeTrackRow({ title, subtitle, artworkHash, playback, onPlay }: Omit<HomeMediaProps, 'subtitle'> & { subtitle: string }) {
  const reveal = useHoverRevealCard(`${title}:${subtitle}`)
  const label = homePlaybackLabel(`${title} by ${subtitle}`, playback)
  return (
    <button {...reveal.cardProps} type="button" className={`home-track-row home-hover-playback${playback.playing || playback.pending ? ' has-playback-indicator' : ''}`} onClick={onPlay} disabled={playback.disabled}
      aria-label={label} aria-busy={playback.pending} title={reveal.reducedMotion ? `${title} — ${subtitle}` : undefined} data-controller-focusable={playback.disabled ? undefined : 'true'}>
      <HomeArtwork hash={artworkHash} title={title} />
      <span className="home-media-copy">
        <strong className="home-media-title" title={title}>{title}</strong>
        <HoverRevealText className="home-media-subtitle" text={subtitle} {...reveal.textProps} />
      </span>
      <span className="home-floating-playback"><HomePlaybackGlyph state={playback} /></span>
    </button>
  )
}
