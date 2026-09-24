import AlbumArtwork from '../library/AlbumArtwork'
import PlaylistCover from '../playlists/PlaylistCover'

export default function HomeArtwork({ hash, title, playlist = false, favorites = false }: {
  hash: string | null
  title: string
  playlist?: boolean
  favorites?: boolean
}) {
  return (
    <span className="home-media-artwork" aria-hidden="true">
      {playlist ? (
        <PlaylistCover hash={hash} name={title} isFavorites={favorites} className="home-media-cover" />
      ) : (
        <AlbumArtwork hash={hash} alt="" className="home-media-cover" variant="card" />
      )}
    </span>
  )
}
