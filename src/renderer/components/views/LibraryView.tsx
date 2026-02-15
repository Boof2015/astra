import { useEffect, useMemo, useRef, useState } from 'react'
import { useLibraryStore } from '../../stores/libraryStore'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import { Track } from '../../types/audio'
import TrackList from '../library/TrackList'
import AlbumArtwork from '../library/AlbumArtwork'
import ArtistList from '../library/ArtistList'

export default function LibraryView() {
  const tracks = useLibraryStore((state) => state.tracks)
  const albums = useLibraryStore((state) => state.albums)
  const artists = useLibraryStore((state) => state.artists)
  const viewMode = useLibraryStore((state) => state.viewMode)
  const selectedAlbum = useLibraryStore((state) => state.selectedAlbum)
  const selectedArtist = useLibraryStore((state) => state.selectedArtist)
  const selectionOrigin = useLibraryStore((state) => state.selectionOrigin)
  const isLoading = useLibraryStore((state) => state.isLoading)
  const isScanning = useLibraryStore((state) => state.isScanning)
  const scanProgress = useLibraryStore((state) => state.scanProgress)
  const setViewMode = useLibraryStore((state) => state.setViewMode)
  const selectAlbum = useLibraryStore((state) => state.selectAlbum)
  const selectArtist = useLibraryStore((state) => state.selectArtist)
  const clearSelection = useLibraryStore((state) => state.clearSelection)

  const loadTrack = usePlayerStore((s) => s.loadTrack)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const [searchQuery, setSearchQuery] = useState('')
  const previousInDetailViewRef = useRef(false)

  const normalizedQuery = searchQuery.trim().toLowerCase()
  const hasSearchQuery = normalizedQuery.length > 0
  const inDetailView = Boolean(selectedAlbum || selectedArtist)

  useEffect(() => {
    if (!previousInDetailViewRef.current && inDetailView) {
      setSearchQuery('')
    }
    previousInDetailViewRef.current = inDetailView
  }, [inDetailView])

  const filteredTracks = useMemo(() => {
    if (!hasSearchQuery) return tracks
    return tracks.filter((track) =>
      track.title.toLowerCase().includes(normalizedQuery)
      || track.artist.toLowerCase().includes(normalizedQuery)
      || track.album.toLowerCase().includes(normalizedQuery)
    )
  }, [tracks, hasSearchQuery, normalizedQuery])

  const filteredAlbums = useMemo(() => {
    if (!hasSearchQuery) return albums
    return albums.filter((album) =>
      album.album.toLowerCase().includes(normalizedQuery)
      || album.artist.toLowerCase().includes(normalizedQuery)
    )
  }, [albums, hasSearchQuery, normalizedQuery])

  const filteredArtists = useMemo(() => {
    if (!hasSearchQuery) return artists
    return artists.filter((artist) => artist.artist.toLowerCase().includes(normalizedQuery))
  }, [artists, hasSearchQuery, normalizedQuery])

  const trimmedQueryForMessage = searchQuery.trim()
  const searchPlaceholder = inDetailView
    ? 'Search tracks...'
    : viewMode === 'albums'
      ? 'Search albums...'
      : viewMode === 'artists'
        ? 'Search artists...'
        : 'Search tracks...'

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
        channels: result.metadata?.channels,
        codec: result.metadata?.codec,
        codecProfile: result.metadata?.codecProfile,
        isAtmosJoc: result.metadata?.isAtmosJoc,
      }
      await loadTrack(track, result.data)
    }
  }

  // Header
  let title = 'Library'
  let showViewTabs = true
  let itemCount = filteredTracks.length
  let itemLabel = filteredTracks.length === 1 ? 'track' : 'tracks'

  if (selectedAlbum) {
    title = selectedAlbum.album
    showViewTabs = false
  } else if (selectedArtist) {
    title = selectedArtist
    showViewTabs = false
  } else if (viewMode === 'albums') {
    itemCount = filteredAlbums.length
    itemLabel = filteredAlbums.length === 1 ? 'album' : 'albums'
  } else if (viewMode === 'artists') {
    itemCount = filteredArtists.length
    itemLabel = filteredArtists.length === 1 ? 'artist' : 'artists'
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

    if (hasSearchQuery && filteredTracks.length === 0 && (selectedAlbum || selectedArtist || viewMode === 'tracks')) {
      return (
        <div className="library-empty">
          <p>No tracks found for "{trimmedQueryForMessage}"</p>
        </div>
      )
    }

    // Albums grid
    if (viewMode === 'albums' && !selectedAlbum && !selectedArtist) {
      if (filteredAlbums.length === 0) {
        return hasSearchQuery
          ? <div className="library-empty"><p>No albums found for "{trimmedQueryForMessage}"</p></div>
          : <div className="library-empty"><p>No albums found</p></div>
      }
      return (
        <div className="album-grid">
          {filteredAlbums.map((album) => (
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
      if (filteredArtists.length === 0) {
        return hasSearchQuery
          ? <div className="library-empty"><p>No artists found for "{trimmedQueryForMessage}"</p></div>
          : <div className="library-empty"><p>No artists found</p></div>
      }
      return <ArtistList artists={filteredArtists} onSelectArtist={selectArtist} />
    }

    // Tracks
    return <TrackList tracks={filteredTracks} showArtist={!selectedArtist} showAlbum={!selectedAlbum} />
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
          <div className="search-container">
            <span className="search-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            </span>
            <input
              type="text"
              className="search-input"
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery.length > 0 && (
              <button
                type="button"
                className="search-clear-btn"
                aria-label="Clear search"
                title="Clear search"
                onClick={() => setSearchQuery('')}
              >
                ×
              </button>
            )}
          </div>
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
