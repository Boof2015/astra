import { useEffect, useMemo, useRef, useState } from 'react'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import { useOpenArtistInLibrary } from '../../hooks/useOpenArtistInLibrary'
import { useOpenAlbumInLibrary } from '../../hooks/useOpenAlbumInLibrary'
import { usePlaybackClock } from '../../hooks/usePlaybackClock'
import AlbumArtwork from '../library/AlbumArtwork'
import ArtistNameLinks from '../library/ArtistNameLinks'
import { useLyricsStore } from '../../stores/lyricsStore'
import {
  buildLyricsQuery,
  findActiveSyncedLineIndex,
  getActiveLyricsResult,
  INFO_SIDEBAR_LYRICS_BODY_COPY,
  resolveLyricsBodyState
} from '../../utils/lyricsPresentation'

type InfoSidebarTab = 'info' | 'lyrics'

export default function InfoSidebar() {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const currentTime = usePlaybackClock()
  const playbackState = usePlayerStore((s) => s.playbackState)
  const toggleInfoSidebar = useUIStore((s) => s.toggleInfoSidebar)
  const openArtistInLibrary = useOpenArtistInLibrary()
  const openAlbumInLibrary = useOpenAlbumInLibrary()
  const [activeTab, setActiveTab] = useState<InfoSidebarTab>('info')
  const lyricsTrackPath = useLyricsStore((s) => s.currentTrackPath)
  const lyricsResult = useLyricsStore((s) => s.currentResult)
  const lyricsIsLoading = useLyricsStore((s) => s.isLoading)
  const lyricsStoreError = useLyricsStore((s) => s.errorMessage)
  const loadLyricsForTrack = useLyricsStore((s) => s.loadForTrack)
  const refreshLyricsForTrack = useLyricsStore((s) => s.refreshForTrack)
  const syncedLineRefs = useRef<Map<number, HTMLParagraphElement>>(new Map())

  const lyricsQuery = useMemo(() => buildLyricsQuery(currentTrack), [currentTrack])
  const activeLyricsResult = useMemo(() => (
    getActiveLyricsResult(currentTrack?.path ?? null, lyricsTrackPath, lyricsResult)
  ), [currentTrack?.path, lyricsResult, lyricsTrackPath])

  const bodyState = useMemo(() => resolveLyricsBodyState({
    currentTrack,
    activeLyricsResult,
    isLoading: lyricsIsLoading,
    errorMessage: lyricsStoreError,
    copy: INFO_SIDEBAR_LYRICS_BODY_COPY
  }), [activeLyricsResult, currentTrack, lyricsIsLoading, lyricsStoreError])
  const syncedLines = bodyState.kind === 'hit_synced' ? bodyState.syncedLines : []
  const activeSyncedLineIndex = useMemo(
    () => findActiveSyncedLineIndex(syncedLines, currentTime),
    [currentTime, syncedLines]
  )

  useEffect(() => {
    if (activeTab !== 'lyrics') return
    void loadLyricsForTrack(lyricsQuery)
  }, [activeTab, lyricsQuery, loadLyricsForTrack])

  useEffect(() => {
    if (activeTab !== 'lyrics') return
    if (playbackState !== 'playing') return
    if (activeSyncedLineIndex < 0) return
    const node = syncedLineRefs.current.get(activeSyncedLineIndex)
    if (!node) return
    node.scrollIntoView({
      block: 'center',
      behavior: 'smooth'
    })
  }, [activeSyncedLineIndex, activeTab, playbackState])

  const setSyncedLineRef = (index: number) => (node: HTMLParagraphElement | null) => {
    if (node) {
      syncedLineRefs.current.set(index, node)
      return
    }
    syncedLineRefs.current.delete(index)
  }

  const revealTrackInFolder = () => {
    if (!currentTrack) return
    void window.electronAPI.revealFileInFolder(currentTrack.path)
  }

  const refreshLyrics = () => {
    if (!lyricsQuery) return
    void refreshLyricsForTrack(lyricsQuery)
  }

  const renderLyricsContent = () => {
    if (bodyState.kind === 'hit_synced') {
      return (
        <>
          <p className="info-lyrics-meta">
            Source: {bodyState.sourceLabel}
            {' • Synced'}
            {bodyState.cached ? ' (cached)' : ''}
          </p>

          <div className="info-lyrics-lines">
            {bodyState.syncedLines.map((line, index) => (
              <p
                key={`${line.timestampMs}:${index}`}
                ref={setSyncedLineRef(index)}
                className={`info-lyrics-line ${index === activeSyncedLineIndex ? 'active' : ''}`}
              >
                {line.text}
              </p>
            ))}
          </div>
        </>
      )
    }

    if (bodyState.kind === 'hit_plain') {
      return (
        <>
          <p className="info-lyrics-meta">
            Source: {bodyState.sourceLabel}
            {' • Unsynced'}
            {bodyState.cached ? ' (cached)' : ''}
          </p>
          <pre className="info-lyrics-plain">{bodyState.plainLyrics}</pre>
        </>
      )
    }

    if (bodyState.kind === 'hit_empty') {
      return (
        <>
          <p className="info-lyrics-meta">
            Source: {bodyState.sourceLabel}
            {' • Unsynced'}
            {bodyState.cached ? ' (cached)' : ''}
          </p>
          <div className="info-lyrics-state">
            {bodyState.message}
          </div>
        </>
      )
    }

    return (
      <div className={`info-lyrics-state ${bodyState.kind === 'transient_error' ? 'info-lyrics-state-error' : ''}`.trim()}>
        {bodyState.message}
      </div>
    )
  }

  return (
    <aside className={`info-sidebar${activeTab === 'lyrics' ? ' info-sidebar-lyrics-active' : ''}`}>
      <div className="info-sidebar-header">
        <span className="info-sidebar-label">NOW PLAYING</span>
        <button className="info-sidebar-close" onClick={toggleInfoSidebar} title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </div>

      <div className="info-sidebar-tabs">
        <button
          type="button"
          className={`info-sidebar-tab ${activeTab === 'info' ? 'active' : ''}`}
          onClick={() => setActiveTab('info')}
        >
          Info
        </button>
        <button
          type="button"
          className={`info-sidebar-tab ${activeTab === 'lyrics' ? 'active' : ''}`}
          onClick={() => setActiveTab('lyrics')}
        >
          Lyrics
        </button>
      </div>

      {activeTab === 'lyrics' ? (
        <div className="info-lyrics-panel">
          <div className="info-sidebar-actions">
            <button
              type="button"
              className="info-lyrics-refresh-btn"
              onClick={refreshLyrics}
              disabled={!currentTrack || lyricsIsLoading}
            >
              {lyricsIsLoading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
          {renderLyricsContent()}
        </div>
      ) : currentTrack ? (
        <>
          <div className="info-sidebar-artwork">
            {currentTrack.artworkHash ? (
              <AlbumArtwork hash={currentTrack.artworkHash} alt="Album art" variant="card" />
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
                artistNames={currentTrack.artistNames}
                browseArtistText={currentTrack.albumArtist}
                browseArtistNames={currentTrack.albumArtistNames}
                onArtistClick={openArtistInLibrary}
                className="info-sidebar-artist-links"
                linkClassName="artist-name-link-inline"
              />
            </div>
          </div>

          <div className="info-sidebar-meta">
            <div className="info-meta-row">
              <span className="info-meta-label">Album</span>
              {currentTrack.album.trim().length > 0 ? (
                <button
                  type="button"
                  className="info-meta-value info-meta-album-link"
                  onClick={() => {
                    void openAlbumInLibrary(
                      currentTrack.album,
                      currentTrack.artist,
                      currentTrack.albumArtist,
                      currentTrack.albumIdentityKey
                    )
                  }}
                  title={`Show album ${currentTrack.album}`}
                >
                  {currentTrack.album}
                </button>
              ) : (
                <span className="info-meta-value">{'\u2014'}</span>
              )}
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
            <div className="info-path-header">
              <div className="info-tech-label">File Path</div>
              <button
                type="button"
                className="info-path-reveal-btn"
                onClick={revealTrackInFolder}
                title="Show in Folder"
                aria-label="Show in Folder"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                </svg>
              </button>
            </div>
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
