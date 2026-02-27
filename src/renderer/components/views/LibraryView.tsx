import { useEffect, useMemo, useRef, useState } from 'react'
import { useLibraryStore } from '../../stores/libraryStore'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import { useJumpToNowPlaying } from '../../hooks/useJumpToNowPlaying'
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
  const isCancelingScan = useLibraryStore((state) => state.isCancelingScan)
  const scanProgress = useLibraryStore((state) => state.scanProgress)
  const scanStage = useLibraryStore((state) => state.scanStage)
  const cancelScan = useLibraryStore((state) => state.cancelScan)
  const setViewMode = useLibraryStore((state) => state.setViewMode)
  const selectAlbum = useLibraryStore((state) => state.selectAlbum)
  const selectArtist = useLibraryStore((state) => state.selectArtist)
  const clearSelection = useLibraryStore((state) => state.clearSelection)

  const loadTrack = usePlayerStore((s) => s.loadTrack)
  const currentTrackPath = usePlayerStore((s) => s.currentTrack?.path ?? null)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const libraryTrackRevealRequest = useUIStore((s) => s.libraryTrackRevealRequest)
  const pendingLibrarySearchQuery = useUIStore((s) => s.pendingLibrarySearchQuery)
  const consumePendingLibrarySearchQuery = useUIStore((s) => s.consumePendingLibrarySearchQuery)
  const jumpToNowPlaying = useJumpToNowPlaying()
  const [searchQuery, setSearchQuery] = useState('')
  const previousInDetailViewRef = useRef(false)

  const normalizedQuery = searchQuery.trim().toLowerCase()
  const hasSearchQuery = normalizedQuery.length > 0
  const inDetailView = Boolean(selectedAlbum || selectedArtist)

  useEffect(() => {
    if (pendingLibrarySearchQuery === null) return

    const pendingQuery = consumePendingLibrarySearchQuery()
    if (pendingQuery !== null) {
      setSearchQuery(pendingQuery)
    }
  }, [consumePendingLibrarySearchQuery, pendingLibrarySearchQuery])

  useEffect(() => {
    if (!previousInDetailViewRef.current && inDetailView) {
      setSearchQuery('')
    }
    previousInDetailViewRef.current = inDetailView
  }, [inDetailView])

  useEffect(() => {
    if (!isScanning) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void cancelScan()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [cancelScan, isScanning])

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
        albumArtist: result.metadata?.albumArtist,
        duration: result.metadata?.duration ?? 0,
        format: result.metadata?.format ?? 'unknown',
        artworkData: result.metadata?.artwork,
        channels: result.metadata?.channels,
        codec: result.metadata?.codec,
        codecProfile: result.metadata?.codecProfile,
        isAtmosJoc: result.metadata?.isAtmosJoc,
        replayGainTrackDb: result.metadata?.replayGainTrackDb,
        replayGainAlbumDb: result.metadata?.replayGainAlbumDb,
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
    const stage = scanStage?.stage ?? 'scanning'
    const percent = scanProgress.total > 0 ? (scanProgress.current / scanProgress.total) * 100 : 0
    const isCleanupStage = stage === 'cleanup'
    const displayPercent = isCleanupStage ? 100 : percent
    const scanTitle = stage === 'backfill'
      ? 'Processing Metadata'
      : stage === 'cleanup'
        ? 'Finalizing Library'
        : 'Scanning Library'
    const countUnit = stage === 'backfill' ? 'tracks' : 'files'
    const fileName = scanProgress.file ? scanProgress.file.split('/').pop() || scanProgress.file.split('\\').pop() : ''
    const scanMessage = scanStage?.message
      ?? (!isCleanupStage ? 'Processing...' : 'Finalizing library...')
    const scanDetail = isCleanupStage ? scanMessage : (fileName || scanMessage)
    const showCount = !isCleanupStage && scanProgress.total > 0

    return (
      <div className="scan-overlay">
        <div className="scan-progress">
          <button
            className="scan-cancel-btn"
            onClick={() => void cancelScan()}
            disabled={isCancelingScan}
            aria-label="Cancel scan"
            title="Cancel scan (Esc)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
          <div className="loading-spinner" />
          <div className="scan-title">{scanTitle}</div>
          {showCount && <div className="scan-count">{scanProgress.current} / {scanProgress.total} {countUnit}</div>}
          <div className="scan-bar">
            <div className="scan-bar-fill" style={{ width: `${displayPercent}%` }} />
          </div>
          {scanDetail && <div className="scan-file">{scanDetail}</div>}
          <div className="scan-cancel-hint">{isCancelingScan ? 'Canceling...' : 'Press Esc to cancel'}</div>
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
    return (
      <TrackList
        tracks={filteredTracks}
        showArtist={!selectedArtist}
        showAlbum={!selectedAlbum}
        jumpToTrackRequest={libraryTrackRevealRequest}
      />
    )
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
              data-shortcut-search="true"
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
          <button
            className="icon-btn"
            onClick={() => {
              jumpToNowPlaying()
            }}
            title="Jump to now playing (J)"
            aria-label="Jump to now playing (J)"
            disabled={!currentTrackPath}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="7" />
              <circle cx="12" cy="12" r="2.5" />
              <path d="M12 2v3" />
              <path d="M12 19v3" />
              <path d="M2 12h3" />
              <path d="M19 12h3" />
            </svg>
          </button>
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
