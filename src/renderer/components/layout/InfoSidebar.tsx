import { useEffect, useMemo, useRef, useState } from 'react'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import { useOpenArtistInLibrary } from '../../hooks/useOpenArtistInLibrary'
import AlbumArtwork from '../library/AlbumArtwork'
import ArtistNameLinks from '../library/ArtistNameLinks'
import { useLyricsStore } from '../../stores/lyricsStore'
import type { Track } from '../../types/audio'
import type { LyricsLine, LyricsTrackQuery } from '../../../types/lyrics'

type InfoSidebarTab = 'info' | 'lyrics'

function getLyricsSourceLabel(source: 'embedded' | 'lrclib' | 'manual'): string {
  if (source === 'embedded') return 'Embedded'
  if (source === 'manual') return 'Manual'
  return 'LRCLIB'
}

function buildLyricsQuery(track: Track | null): LyricsTrackQuery | null {
  if (!track) return null
  return {
    path: track.path,
    title: track.title,
    artist: track.artist,
    album: track.album || undefined,
    durationSeconds: Number.isFinite(track.duration) ? track.duration : undefined
  }
}

function findActiveSyncedLineIndex(lines: LyricsLine[], currentTimeSeconds: number): number {
  if (lines.length === 0) return -1
  const currentTimeMs = Number.isFinite(currentTimeSeconds)
    ? Math.max(0, Math.floor(currentTimeSeconds * 1000))
    : 0

  let low = 0
  let high = lines.length - 1
  let best = -1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (lines[mid].timestampMs <= currentTimeMs) {
      best = mid
      low = mid + 1
      continue
    }
    high = mid - 1
  }

  return best
}

export default function InfoSidebar() {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const playbackState = usePlayerStore((s) => s.playbackState)
  const toggleInfoSidebar = useUIStore((s) => s.toggleInfoSidebar)
  const openArtistInLibrary = useOpenArtistInLibrary()
  const [activeTab, setActiveTab] = useState<InfoSidebarTab>('info')
  const lyricsTrackPath = useLyricsStore((s) => s.currentTrackPath)
  const lyricsResult = useLyricsStore((s) => s.currentResult)
  const lyricsIsLoading = useLyricsStore((s) => s.isLoading)
  const lyricsStoreError = useLyricsStore((s) => s.errorMessage)
  const loadLyricsForTrack = useLyricsStore((s) => s.loadForTrack)
  const refreshLyricsForTrack = useLyricsStore((s) => s.refreshForTrack)
  const syncedLineRefs = useRef<Map<number, HTMLParagraphElement>>(new Map())

  const lyricsQuery = useMemo(() => buildLyricsQuery(currentTrack), [currentTrack])
  const activeLyricsResult = useMemo(() => {
    if (!currentTrack) return null
    if (lyricsTrackPath !== currentTrack.path) return null
    return lyricsResult
  }, [currentTrack, lyricsResult, lyricsTrackPath])

  const syncedLines = useMemo(() => {
    if (activeLyricsResult?.status !== 'hit') return []
    return activeLyricsResult.lyrics.syncedLines
  }, [activeLyricsResult])
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
    if (!currentTrack) {
      return (
        <div className="info-lyrics-state">
          No track selected.
        </div>
      )
    }

    if (lyricsIsLoading && !activeLyricsResult) {
      return (
        <div className="info-lyrics-state">
          Loading lyrics...
        </div>
      )
    }

    if (activeLyricsResult?.status === 'transient_error') {
      return (
        <div className="info-lyrics-state info-lyrics-state-error">
          {activeLyricsResult.message}
        </div>
      )
    }

    if (activeLyricsResult?.status === 'not_found') {
      if (activeLyricsResult.reason === 'online-disabled') {
        return (
          <div className="info-lyrics-state">
            No embedded lyrics found. Enable Online Lyrics Lookup in Settings to fetch from LRCLIB.
          </div>
        )
      }
      if (activeLyricsResult.reason === 'provider-not-found') {
        return (
          <div className="info-lyrics-state">
            No lyrics found on LRCLIB for this track.
          </div>
        )
      }
      return (
        <div className="info-lyrics-state">
          No embedded lyrics found for this track.
        </div>
      )
    }

    if (activeLyricsResult?.status === 'hit') {
      const plainLyrics = activeLyricsResult.lyrics.plainLyrics?.trim() ?? ''
      const hasSyncedLyrics = syncedLines.length > 0

      return (
        <>
          <p className="info-lyrics-meta">
            Source: {getLyricsSourceLabel(activeLyricsResult.lyrics.source)}
            {hasSyncedLyrics ? ' • Synced' : ' • Unsynced'}
            {activeLyricsResult.cached ? ' (cached)' : ''}
          </p>

          {hasSyncedLyrics ? (
            <div className="info-lyrics-lines">
              {syncedLines.map((line, index) => (
                <p
                  key={`${line.timestampMs}:${index}`}
                  ref={setSyncedLineRef(index)}
                  className={`info-lyrics-line ${index === activeSyncedLineIndex ? 'active' : ''}`}
                >
                  {line.text}
                </p>
              ))}
            </div>
          ) : plainLyrics ? (
            <pre className="info-lyrics-plain">{plainLyrics}</pre>
          ) : (
            <div className="info-lyrics-state">
              Lyrics were found, but no readable text is available.
            </div>
          )}
        </>
      )
    }

    if (lyricsStoreError) {
      return (
        <div className="info-lyrics-state info-lyrics-state-error">
          {lyricsStoreError}
        </div>
      )
    }

    return (
      <div className="info-lyrics-state">
        Open the Lyrics tab to load lyrics for the current track.
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
