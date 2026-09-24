import { memo, type CSSProperties, type MouseEventHandler, type ReactNode } from 'react'
import { highlightSearchMatch } from '../../utils/searchHighlight'
import type { HomePlaybackControlState } from '../home/HomePlaybackControl'
import LibraryCardPlaybackControl from './LibraryCardPlaybackControl'

interface LibraryCollectionCardProps {
  title: string
  subtitle: ReactNode
  metadata?: ReactNode
  artwork: ReactNode
  playback: HomePlaybackControlState
  onOpen: () => void
  onPlay: () => void
  onContextMenu?: MouseEventHandler<HTMLElement>
  controllerKey: string
  controllerIndex: number
  searchQuery?: string
  className?: string
  style?: CSSProperties
  badge?: ReactNode
}

/** The compact horizontal member of Home's media-card family. */
function LibraryCollectionCard({
  title, subtitle, metadata, artwork, playback, onOpen, onPlay, onContextMenu,
  controllerKey, controllerIndex, searchQuery = '', className = '', style, badge
}: LibraryCollectionCardProps) {
  return (
    <article className={`home-collection-card home-hover-playback library-collection-card ${className}${playback.playing || playback.pending ? ' has-playback-indicator' : ''}`} style={style} onContextMenu={onContextMenu}>
      <button
        type="button"
        className="home-media-open library-collection-open"
        onClick={onOpen}
        aria-label={`Open ${title}`}
        title={title}
        data-controller-focusable="true"
        data-controller-context={onContextMenu ? 'true' : undefined}
        data-controller-key={controllerKey}
        data-controller-index={controllerIndex}
        data-controller-action="open"
      >
        <span className="library-collection-artwork" aria-hidden="true">{artwork}</span>
        <span className="home-media-copy library-collection-copy">
          <strong className="home-media-title library-collection-title">{highlightSearchMatch(title, searchQuery)}</strong>
          <span className="library-collection-subtitle">{subtitle}</span>
          {metadata && <span className="library-collection-meta">{metadata}</span>}
        </span>
      </button>
      <span className="home-floating-playback">
        <LibraryCardPlaybackControl
          title={title}
          state={playback}
          onPlay={onPlay}
          controllerKey={controllerKey}
          controllerIndex={controllerIndex}
          contextMenu={Boolean(onContextMenu)}
        />
      </span>
      {badge}
    </article>
  )
}

export default memo(LibraryCollectionCard)
