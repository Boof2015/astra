import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import { useOpenArtistInLibrary } from '../../hooks/useOpenArtistInLibrary'
import AlbumArtwork from '../library/AlbumArtwork'
import ArtistNameLinks from '../library/ArtistNameLinks'

export default function InfoSidebar() {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const toggleInfoSidebar = useUIStore((s) => s.toggleInfoSidebar)
  const openArtistInLibrary = useOpenArtistInLibrary()

  return (
    <aside className="info-sidebar">
      <div className="info-sidebar-header">
        <span className="info-sidebar-label">NOW PLAYING</span>
        <button className="info-sidebar-close" onClick={toggleInfoSidebar} title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </div>

      {currentTrack ? (
        <>
          <div className="info-sidebar-artwork">
            {currentTrack.artworkHash ? (
              <AlbumArtwork hash={currentTrack.artworkHash} alt="Album art" />
            ) : currentTrack.artworkData ? (
              <img src={currentTrack.artworkData} alt="Album art" />
            ) : (
              <div className="artwork-placeholder">&#9835;</div>
            )}
          </div>

          <div className="info-sidebar-track">
            <h2 className="info-sidebar-title">{currentTrack.title}</h2>
            <div className="info-sidebar-artist">
              <ArtistNameLinks
                artistText={currentTrack.artist}
                onArtistClick={openArtistInLibrary}
                className="info-sidebar-artist-links"
                linkClassName="artist-name-link-inline"
              />
            </div>
          </div>

          <div className="info-sidebar-meta">
            <div className="info-meta-row">
              <span className="info-meta-label">Album</span>
              <span className="info-meta-value">{currentTrack.album}</span>
            </div>
            {currentTrack.year && (
              <div className="info-meta-row">
                <span className="info-meta-label">Year</span>
                <span className="info-meta-value">{currentTrack.year}</span>
              </div>
            )}
            {currentTrack.genre && (
              <div className="info-meta-row">
                <span className="info-meta-label">Genre</span>
                <span className="info-meta-value">{currentTrack.genre}</span>
              </div>
            )}
            {currentTrack.trackNumber && (
              <div className="info-meta-row">
                <span className="info-meta-label">Track</span>
                <span className="info-meta-value">{currentTrack.trackNumber}</span>
              </div>
            )}
          </div>

          <div className="info-sidebar-technical">
            {currentTrack.format && (
              <div className="info-tech-item">
                <div className="info-tech-label">Codec</div>
                <div className="info-tech-value">{currentTrack.format.toUpperCase()}</div>
              </div>
            )}
            {currentTrack.bitDepth && (
              <div className="info-tech-item">
                <div className="info-tech-label">Bit Depth</div>
                <div className="info-tech-value">{currentTrack.bitDepth}-bit</div>
              </div>
            )}
            {currentTrack.sampleRate && (
              <div className="info-tech-item">
                <div className="info-tech-label">Sample Rate</div>
                <div className="info-tech-value">{currentTrack.sampleRate >= 1000 ? `${(currentTrack.sampleRate / 1000).toFixed(1)} kHz` : `${currentTrack.sampleRate} Hz`}</div>
              </div>
            )}
            {currentTrack.bitrate && (
              <div className="info-tech-item">
                <div className="info-tech-label">Bitrate</div>
                <div className="info-tech-value">{currentTrack.bitrate} kbps</div>
              </div>
            )}
            {currentTrack.channels && (
              <div className="info-tech-item">
                <div className="info-tech-label">Channels</div>
                <div className="info-tech-value">{currentTrack.channels}</div>
              </div>
            )}
            {currentTrack.isAtmosJoc && (
              <div className="info-tech-item info-tech-item-warning">
                <div className="info-tech-label">Atmos Source</div>
                <div className="info-tech-value">Compatibility mode. Object rendering and mix quality are not guaranteed.</div>
              </div>
            )}
          </div>

          <div className="info-sidebar-path">
            <div className="info-tech-label">File Path</div>
            <div className="info-path-value">{currentTrack.path}</div>
          </div>
        </>
      ) : (
        <div className="info-sidebar-empty">
          <p>No track selected</p>
        </div>
      )}
    </aside>
  )
}
