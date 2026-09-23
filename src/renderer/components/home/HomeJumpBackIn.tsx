import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { HomeReleaseSummary } from '../../../types/home'
import type { PlaybackState } from '../../types/audio'
import type { DisplayPlaylist } from '../../utils/playlistSystem'
import AlbumArtwork from '../library/AlbumArtwork'
import PlaylistCover from '../playlists/PlaylistCover'

interface JumpBackInCardBase {
  key: string
  title: string
  subtitle: string
  artworkHash: string | null
  detail: string
  lastPlayedAt: number
  active: boolean
}

export type JumpBackInCard = JumpBackInCardBase & (
  | { kind: 'album'; release: HomeReleaseSummary }
  | { kind: 'playlist'; playlist: DisplayPlaylist }
)

interface HomeJumpBackInProps {
  cards: readonly JumpBackInCard[]
  playbackState: PlaybackState
  pendingPlaybackKey: string | null
  onOpen: (card: JumpBackInCard) => void
  onPlay: (card: JumpBackInCard) => void
}

export default function HomeJumpBackIn({ cards, playbackState, pendingPlaybackKey, onOpen, onPlay }: HomeJumpBackInProps) {
  const gridId = useId()
  const gridRef = useRef<HTMLDivElement | null>(null)
  const [collapsedItemCount, setCollapsedItemCount] = useState(2)
  const [expanded, setExpanded] = useState(false)
  const [revealingKeys, setRevealingKeys] = useState<ReadonlyMap<string, number>>(() => new Map())

  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    let measuredColumns = 0

    const update = () => {
      if (!grid.clientWidth) return
      // CSS owns the column sizing. Read its resolved tracks so two rows also
      // adapt to sidebar changes and UI scaling, not just window breakpoints.
      const tracks = window.getComputedStyle(grid).gridTemplateColumns
      const columns = tracks && tracks !== 'none' ? tracks.trim().split(/\s+/).length : 1
      if (columns === measuredColumns) return
      measuredColumns = columns
      setCollapsedItemCount(columns * 2)
      setRevealingKeys(new Map())
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [cards.length])

  if (!cards.length) return null

  const expandedItemCount = collapsedItemCount * 2
  const visibleCards = cards.slice(0, expanded ? expandedItemCount : collapsedItemCount)
  const hasMore = cards.length > collapsedItemCount

  const showMore = () => {
    const nextCards = cards.slice(collapsedItemCount, expandedItemCount)
    setRevealingKeys(new Map(nextCards.map((card, index) => [card.key, index])))
    setExpanded(true)
  }

  const showLess = () => {
    setExpanded(false)
    setRevealingKeys(new Map())
  }

  return (
    <section className="home-dashboard-section home-jump-section" data-controller-group="home-jump-back-in" data-controller-axis="grid">
      <div className="home-dashboard-section-header">
        <div><h2>Jump back in</h2></div>
      </div>
      <div className="home-jump-grid" id={gridId} ref={gridRef}>
        {visibleCards.map((card) => {
          const isPlaying = card.active && playbackState === 'playing'
          const isPending = pendingPlaybackKey === card.key || (card.active && playbackState === 'loading')
          const playLabel = isPending ? `Starting ${card.title}` : `${isPlaying ? 'Pause' : card.active ? 'Continue' : 'Play'} ${card.title}`
          const revealIndex = revealingKeys.get(card.key)

          return (
            <article
              className={`home-jump-card${isPlaying ? ' is-playing' : ''}${revealIndex !== undefined ? ' is-expansion-reveal' : ''}`}
              style={revealIndex !== undefined ? { animationDelay: `${Math.min(revealIndex, 8) * 18}ms` } : undefined}
              key={card.key}
            >
              <button
                type="button"
                className="home-jump-open"
                onClick={() => onOpen(card)}
                data-controller-focusable="true"
                data-controller-context="true"
                aria-label={`Open ${card.title}`}
                title={card.title}
              >
                <span className="home-jump-artwork">
                  {card.kind === 'playlist' ? (
                    <PlaylistCover hash={card.artworkHash} name={card.title} isFavorites={card.playlist.isSystemFavorites} className="home-jump-cover" />
                  ) : (
                    <AlbumArtwork hash={card.artworkHash} alt={card.title} className="home-jump-cover" variant="card" />
                  )}
                </span>
                <span className="home-jump-copy">
                  <strong className="home-jump-title">
                    <span>{card.title}</span>
                    {isPlaying && (
                      <svg className="home-jump-playing" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" role="img" aria-label="Playing now">
                        <path d="M4 10v4" />
                        <path d="M9 5v14" />
                        <path d="M14 8v8" />
                        <path d="M19 3v18" />
                      </svg>
                    )}
                  </strong>
                  <span className="home-jump-meta">{card.subtitle} · <span>{card.detail}</span></span>
                </span>
              </button>
              <button
                type="button"
                className="home-jump-play"
                onClick={() => onPlay(card)}
                disabled={pendingPlaybackKey !== null || isPending}
                aria-label={playLabel}
                aria-busy={isPending}
                title={playLabel}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  {isPending ? <path d="M6 10h2v4H6zm5 0h2v4h-2zm5 0h2v4h-2z" /> : isPlaying ? <path d="M6 5h4v14H6zm8 0h4v14h-4z" /> : <path d="M8 5v14l11-7z" />}
                </svg>
              </button>
            </article>
          )
        })}
      </div>
      {hasMore && (
        <div className="home-jump-footer">
          <button type="button" className="home-jump-expand" data-controller-focusable="true" data-controller-key="home-jump:expand" aria-expanded={expanded} aria-controls={gridId} onClick={expanded ? showLess : showMore}>
            {expanded ? 'Show less' : 'Show more'}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={expanded ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
            </svg>
          </button>
        </div>
      )}
    </section>
  )
}
