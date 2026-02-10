import { useLibraryStore } from '../../stores/libraryStore'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import { Track } from '../../types/audio'
import TrackList from '../library/TrackList'
import AlbumArtwork from '../library/AlbumArtwork'

export default function LibraryView() {
  const {
    tracks,
    albums,
    artists,
    viewMode,
    selectedAlbum,
    selectedArtist,
    selectionOrigin,
    isLoading,
    isScanning,
    scanProgress,
    setViewMode,
    selectAlbum,
    selectArtist,
    clearSelection,
  } = useLibraryStore()

  const loadTrack = usePlayerStore((s) => s.loadTrack)
  const setActiveView = useUIStore((s) => s.setActiveView)

  const handleBack = async () => {
    const shouldReturnHome = selectionOrigin === 'home'
    if (shouldReturnHome) {
      setActiveView('home')
    }
    await clearSelection()
  }

  const handleOpenFile = async () => {
    const result = await window.electronAPI.openAudioFile()
    if (result) {
      const track: Track = {
        id: result.path,
        path: result.path,
        title: result.metadata?.title ?? result.name,
        artist: result.metadata?.artist ?? 'Unknown Artist',
        album: result.metadata?.album ?? 'Unknown Album',
        duration: result.metadata?.duration ?? 0,
        format: result.metadata?.format ?? 'unknown',
        artworkData: result.metadata?.artwork,
      }
      await loadTrack(track, result.data)
    }
  }

  // Header
  let title = 'Library'
  let showViewTabs = true
  let itemCount = tracks.length
  let itemLabel = tracks.length === 1 ? 'track' : 'tracks'

  if (selectedAlbum) {
    title = selectedAlbum.album
    showViewTabs = false
  } else if (selectedArtist) {
    title = selectedArtist
    showViewTabs = false
  } else if (viewMode === 'albums') {
    itemCount = albums.length
    itemLabel = albums.length === 1 ? 'album' : 'albums'
  } else if (viewMode === 'artists') {
    itemCount = artists.length
    itemLabel = artists.length === 1 ? 'artist' : 'artists'
  }

  // Scan progress overlay
  const renderScanProgress = () => {
    if (!isScanning || !scanProgress) return null
    const percent = scanProgress.total > 0 ? (scanProgress.current / scanProgress.total) * 100 : 0
    const fileName = scanProgress.file ? scanProgress.file.split('/').pop() || scanProgress.file.split('\\').pop() : ''
    return (
      <div className="scan-overlay">
        <div className="scan-progress">
          <div className="loading-spinner" />
          <div className="scan-title">Scanning Library</div>
          <div className="scan-count">{scanProgress.current} / {scanProgress.total} files</div>
          <div className="scan-bar">
            <div className="scan-bar-fill" style={{ width: `${percent}%` }} />
          </div>
          {fileName && <div className="scan-file">{fileName}</div>}
        </div>
      </div>
    )
  }

  // Content
  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="library-loading">
          <div className="loading-spinner" />
          <p>Loading library...</p>
        </div>
      )
    }

    const hasContent = tracks.length > 0 || albums.length > 0 || artists.length > 0
    if (!hasContent && !selectedAlbum && !selectedArtist) {
      return (
        <div className="library-empty">
          <div className="empty-icon">&#9835;</div>
          <p>Your library is empty</p>
          <p className="empty-hint">Use Settings &gt; Library &gt; Add Folder to scan your music</p>
        </div>
      )
    }

    // Albums grid
    if (viewMode === 'albums' && !selectedAlbum && !selectedArtist) {
      if (albums.length === 0) {
        return <div className="library-empty"><p>No albums found</p></div>
      }
      return (
        <div className="album-grid">
          {albums.map((album) => (
            <div
              key={`${album.album}-${album.artist}`}
              className="album-card"
              onClick={() => selectAlbum(album.album, album.artist)}
            >
              <div className="album-artwork">
                <AlbumArtwork hash={album.artwork_hash} alt={album.album} />
              </div>
              <div className="album-info">
                <div className="album-title">{album.album}</div>
                <div className="album-artist">{album.artist}</div>
                <div className="album-meta">{album.track_count} tracks{album.year ? ` \u2022 ${album.year}` : ''}</div>
              </div>
            </div>
          ))}
        </div>
      )
    }

    // Artists list
    if (viewMode === 'artists' && !selectedAlbum && !selectedArtist) {
      if (artists.length === 0) {
        return <div className="library-empty"><p>No artists found</p></div>
      }
      return (
        <div className="artist-list">
          {artists.map((artist) => (
            <div
              key={artist.artist}
              className="artist-item"
              onClick={() => selectArtist(artist.artist)}
            >
              <div className="artist-avatar">
                {artist.artist.charAt(0).toUpperCase()}
              </div>
              <div className="artist-info">
                <div className="artist-name">{artist.artist}</div>
                <div className="artist-track-count">{artist.track_count} tracks</div>
              </div>
            </div>
          ))}
        </div>
      )
    }

    // Tracks
    return <TrackList tracks={tracks} showArtist={!selectedArtist} showAlbum={!selectedAlbum} />
  }

  return (
    <div className="library-view">
      <div className="library-header">
        <div className="library-header-left">
          {(selectedAlbum || selectedArtist) && (
            <button className="back-btn" onClick={handleBack} title="Back">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
              </svg>
            </button>
          )}
          <h2>{title}</h2>
          {showViewTabs && (
            <div className="view-tabs">
              <button
                className={`view-tab ${viewMode === 'tracks' ? 'active' : ''}`}
                onClick={() => setViewMode('tracks')}
              >
                Tracks
              </button>
              <button
                className={`view-tab ${viewMode === 'albums' ? 'active' : ''}`}
                onClick={() => setViewMode('albums')}
              >
                Albums
              </button>
              <button
                className={`view-tab ${viewMode === 'artists' ? 'active' : ''}`}
                onClick={() => setViewMode('artists')}
              >
                Artists
              </button>
            </div>
          )}
          <span className="track-count">
            {itemCount} {itemLabel}
          </span>
        </div>
        <div className="library-header-right">
          <button className="icon-btn" onClick={handleOpenFile} title="Open File">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
            </svg>
          </button>
        </div>
      </div>

      {renderScanProgress()}

      <div className="library-content">
        {renderContent()}
      </div>
    </div>
  )
}
