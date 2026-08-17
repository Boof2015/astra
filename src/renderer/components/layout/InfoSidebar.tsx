import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LastFmArtistInfo } from '../../../types/lastFm'
import { usePlayerStore } from '../../stores/playerStore'
import { useLibraryStore } from '../../stores/libraryStore'
import { useUIStore } from '../../stores/uiStore'
import { useOpenArtistInLibrary } from '../../hooks/useOpenArtistInLibrary'
import { useOpenAlbumInLibrary } from '../../hooks/useOpenAlbumInLibrary'
import { usePlaybackClock } from '../../hooks/usePlaybackClock'
import { useLyricsSyncedView } from '../../hooks/useLyricsSyncedView'
import AlbumArtwork from '../library/AlbumArtwork'
import ArtistNameLinks from '../library/ArtistNameLinks'
import { normalizeKey } from '../../utils/albumIdentity'
import { useLyricsStore } from '../../stores/lyricsStore'
import { useAudioSettingsStore } from '../../stores/audioSettingsStore'
import { useLyricsDisplaySettingsStore } from '../../stores/lyricsDisplaySettingsStore'
import LyricsLineContent from '../lyrics/LyricsLineContent'
import {
  buildLyricsQuery,
  getCompensatedLyricsTime,
  getActiveLyricsResult,
  getLyricsLineSeekTimeSeconds,
  getSyncedLyricsDisplayLines,
  INFO_SIDEBAR_LYRICS_BODY_COPY,
  resolveSyncedLyricsTiming,
  resolveLyricsBodyState
} from '../../utils/lyricsPresentation'

type InfoSidebarTab = 'info' | 'lyrics' | 'bio'

type ArtistBioState =
  | { status: 'no-artist' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; artist: LastFmArtistInfo }

export default function InfoSidebar() {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const libraryArtists = useLibraryStore((s) => s.artists)
  const currentTime = usePlaybackClock(0.1)
  const duration = usePlayerStore((s) => s.duration)
  const seek = usePlayerStore((s) => s.seek)
  const effectiveDelayMs = useAudioSettingsStore((s) => s.effectiveDelayMs)
  const toggleInfoSidebar = useUIStore((s) => s.toggleInfoSidebar)
  const openSignalShare = useUIStore((s) => s.openSignalShare)
  const openArtistInLibrary = useOpenArtistInLibrary()
  const openAlbumInLibrary = useOpenAlbumInLibrary()
  const [activeTab, setActiveTab] = useState<InfoSidebarTab>('info')
  const [isGenreExpanded, setIsGenreExpanded] = useState(false)
  const [bioState, setBioState] = useState<ArtistBioState>({ status: 'no-artist' })
  const [isBioTagsExpanded, setIsBioTagsExpanded] = useState(false)
  const artistBioCacheRef = useRef<Map<string, LastFmArtistInfo>>(new Map())
  const lyricsTrackPath = useLyricsStore((s) => s.currentTrackPath)
  const lyricsResult = useLyricsStore((s) => s.currentResult)
  const lyricsIsLoading = useLyricsStore((s) => s.isLoading)
  const lyricsStoreError = useLyricsStore((s) => s.errorMessage)
  const loadLyricsForTrack = useLyricsStore((s) => s.loadForTrack)
  const refreshLyricsForTrack = useLyricsStore((s) => s.refreshForTrack)
  const lyricsDisplaySettings = useLyricsDisplaySettingsStore((s) => s.settings)

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
  const displayedSyncedLines = useMemo(
    () => getSyncedLyricsDisplayLines(syncedLines, { durationSeconds: duration }),
    [duration, syncedLines]
  )
  const compensatedTime = useMemo(
    () => getCompensatedLyricsTime(currentTime, duration, effectiveDelayMs),
    [currentTime, duration, effectiveDelayMs]
  )
  const syncedLyricsTiming = useMemo(
    () => resolveSyncedLyricsTiming(syncedLines, compensatedTime, { durationSeconds: duration }),
    [compensatedTime, duration, syncedLines]
  )
  const activeSyncedLineIndex = syncedLyricsTiming.activeLineIndex
  const hasSyncedLyrics = displayedSyncedLines.some((line) => line.kind === 'lyric')

  const {
    followPaused,
    expandedListRef,
    setFollowPaused,
    setSyncedLineRef,
    pauseFollowFromManualScroll,
    handleRecenter
  } = useLyricsSyncedView({
    isOpen: activeTab === 'lyrics',
    isExpanded: true,
    hasSyncedLyrics,
    activeSyncedLineIndex,
    focusedSyncedLineIndex: syncedLyricsTiming.focusLineIndex,
    contentKey: currentTrack?.path ?? null
  })

  useEffect(() => {
    if (activeTab !== 'lyrics') return
    void loadLyricsForTrack(lyricsQuery)
  }, [activeTab, lyricsQuery, loadLyricsForTrack])

  useEffect(() => {
    if (activeTab !== 'bio') return

    setIsBioTagsExpanded(false)
    const artistName = currentTrack?.artist.trim()
    if (!artistName) {
      setBioState({ status: 'no-artist' })
      return
    }

    const cached = artistBioCacheRef.current.get(artistName)
    if (cached) {
      setBioState({ status: 'success', artist: cached })
      return
    }

    let cancelled = false
    setBioState({ status: 'loading' })

    window.electronAPI.lastFm.getArtistInfo(artistName)
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setBioState({ status: 'error', message: result.message })
          return
        }

        artistBioCacheRef.current.set(artistName, result.artist)
        setBioState({ status: 'success', artist: result.artist })
      })
      .catch(() => {
        if (cancelled) return
        setBioState({ status: 'error', message: 'Failed to load artist biography.' })
      })

    return () => {
      cancelled = true
    }
  }, [activeTab, currentTrack?.artist])

  const revealTrackInFolder = () => {
    if (!currentTrack) return
    void window.electronAPI.revealFileInFolder(currentTrack.path)
  }

  const refreshLyrics = () => {
    if (!lyricsQuery) return
    void refreshLyricsForTrack(lyricsQuery)
  }

  const handleLyricsLineSeek = useCallback((seekTimeSeconds: number) => {
    setFollowPaused(false)
    void seek(seekTimeSeconds)
  }, [seek, setFollowPaused])

  const renderLyricsContent = () => {
    if (bodyState.kind === 'hit_synced') {
      return (
        <>
          <p className="info-lyrics-meta">
            Source: {bodyState.sourceLabel}
            {' • Synced'}
            {bodyState.cached ? ' (cached)' : ''}
          </p>

          <div
            ref={expandedListRef}
            className="info-lyrics-lines"
            onWheel={pauseFollowFromManualScroll}
            onTouchStart={pauseFollowFromManualScroll}
            aria-live="polite"
          >
            {displayedSyncedLines.map((displayLine) => (
              <p
                key={displayLine.key}
                ref={setSyncedLineRef(displayLine.displayIndex)}
                className={[
                  'info-lyrics-line',
                  displayLine.kind === 'gap' ? 'is-gap' : '',
                  displayLine.kind === 'lyric' && displayLine.displayIndex === activeSyncedLineIndex ? 'active' : ''
                ].join(' ').trim()}
                aria-hidden={displayLine.kind === 'gap'}
              >
                <LyricsLineContent
                  displayLine={displayLine}
                  currentTimeSeconds={compensatedTime}
                  isActive={displayLine.kind === 'lyric' && displayLine.displayIndex === activeSyncedLineIndex}
                  settings={lyricsDisplaySettings}
                  seekTimeSeconds={displayLine.kind === 'lyric'
                    ? getLyricsLineSeekTimeSeconds(displayLine.timestampMs, duration, effectiveDelayMs)
                    : null}
                  onSeek={handleLyricsLineSeek}
                />
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

  const renderBioContent = () => {
    if (bioState.status === 'no-artist') {
      return <div className="info-lyrics-state">No artist selected.</div>
    }

    if (bioState.status === 'loading') {
      return <div className="info-lyrics-state">Chargement...</div>
    }

    if (bioState.status === 'error') {
      return <div className="info-lyrics-state info-lyrics-state-error">{bioState.message}</div>
    }

    const { artist } = bioState
    const libraryArtistKey = normalizeKey(artist.name)
    const libraryArtistRecord = libraryArtists.find((libraryArtist) => normalizeKey(libraryArtist.artist) === libraryArtistKey) ?? null
    const libraryArtworkHash = libraryArtistRecord?.artwork_hash ?? null

    return (
      <>
        <div className="info-bio-artwork">
          {libraryArtworkHash && <AlbumArtwork hash={libraryArtworkHash} alt={artist.name} />}
        </div>
        <h2 className="info-bio-name">{artist.name}</h2>
        {artist.tags.length > 0 && (
          <div className="info-meta-row">
            <span className="info-meta-label">Genre</span>
            <span
              className={`info-meta-value info-meta-value--clickable ${isBioTagsExpanded ? 'info-meta-value--wrap' : ''}`}
              onClick={() => setIsBioTagsExpanded(!isBioTagsExpanded)}
              title="Cliquer pour tout voir"
            >
              {artist.tags.join(', ')}
            </span>
          </div>
        )}
        {artist.bio ? (
          <p className="info-bio-text">{artist.bio}</p>
        ) : (
          <div className="info-lyrics-state">No biography available.</div>
        )}
      </>
    )
  }

  return (
    <aside className={`info-sidebar${activeTab === 'lyrics' || activeTab === 'bio' ? ' info-sidebar-lyrics-active' : ''}`}>
      <div className="info-sidebar-header">
        <span className="info-sidebar-label">NOW PLAYING</span>
        <div className="info-sidebar-header-actions">
          {currentTrack && (
            <button
              type="button"
              className="info-sidebar-close info-sidebar-signal"
              onClick={() => openSignalShare({
                artist: currentTrack.artist,
                title: currentTrack.title,
                duration: currentTrack.duration
              })}
              title="Create Astra Signal"
              aria-label="Create Astra Signal for the current track"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 12h3l2-6 4 12 3-9 2 3h4" />
              </svg>
            </button>
          )}
          <button className="info-sidebar-close" type="button" onClick={toggleInfoSidebar} title="Close" aria-label="Close track info">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>
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
        <button
          type="button"
          className={`info-sidebar-tab ${activeTab === 'bio' ? 'active' : ''}`}
          onClick={() => setActiveTab('bio')}
        >
          Bio
        </button>
      </div>

      {activeTab === 'lyrics' ? (
        <div className="info-lyrics-panel">
          <div className="info-sidebar-actions">
            {followPaused && hasSyncedLyrics && (
              <button
                type="button"
                className="info-lyrics-recenter-btn"
                onClick={handleRecenter}
              >
                Recenter
              </button>
            )}
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
      ) : activeTab === 'bio' ? (
        <div className="info-bio-panel">
          {renderBioContent()}
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
                <span className="info-meta-label">Release Date</span>
                <span className="info-meta-value">{currentTrack.date || currentTrack.year}</span>
              </div>
            )}
            {currentTrack.genre && (
              <div className="info-meta-row">
                <span className="info-meta-label">Genre</span>
                <span
                  className={`info-meta-value info-meta-value--clickable ${isGenreExpanded ? 'info-meta-value--wrap' : ''}`}
                  onClick={() => setIsGenreExpanded(!isGenreExpanded)}
                  title="Cliquer pour tout voir"
                >
                  {currentTrack.genre}
                </span>
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
            {currentTrack.isIamf && (
              <div className="info-tech-item">
                <div className="info-tech-label">Eclipsa Source</div>
                <div className="info-tech-value">Eclipsa Audio (IAMF) decoded to 7.1.4.</div>
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
