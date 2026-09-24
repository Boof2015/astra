import { HOME_SHELF_ITEM_LIMIT } from '../../../shared/home/homeDashboard'
import HomeExpandableGrid from './HomeExpandableGrid'

const placeholderItems = Array.from({ length: HOME_SHELF_ITEM_LIMIT }, (_, index) => index)

function LoadingCard({ album = false }: { album?: boolean }) {
  return (
    <article className={`${album ? 'home-media-album' : 'home-collection-card home-hover-playback'} home-loading-card`} aria-hidden="true">
      <div className="home-media-open">
        <span className="home-media-artwork home-skeleton-block" />
        <span className="home-media-copy">
          <span className="home-media-title home-skeleton-block" />
          <span className="home-media-subtitle home-skeleton-block" />
        </span>
      </div>
      {album && (
        <div className="home-album-footer">
          <span className="home-media-context home-skeleton-block" />
          <span className="home-playback-glyph home-skeleton-block" />
        </div>
      )}
    </article>
  )
}

export function HomeLoadingCollectionGrid() {
  return (
    <div role="status" aria-label="Loading Jump back in">
      <div aria-hidden="true">
        <HomeExpandableGrid items={placeholderItems} maxRows={2} getKey={String} renderItem={() => <LoadingCard />} />
        <div className="home-grid-footer">
          <span className="home-grid-expand home-loading-expand"><span className="home-skeleton-block" /></span>
        </div>
      </div>
    </div>
  )
}

export function HomeLoadingAlbumCards() {
  return <>{placeholderItems.map((index) => <LoadingCard key={index} album />)}</>
}
