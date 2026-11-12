import React from 'react'
import { create } from 'zustand'
import TrackList from '../../src/renderer/components/library/TrackList'
import { ROOT_TRACK_COLUMN_ORDER } from '../../src/renderer/utils/rootTrackTable'

const noop = () => {}
const asyncNoop = async () => {}
const params = new URLSearchParams(location.search)
const trackCount = Number(params.get('tracks') ?? 20000)
const uiScale = Number(params.get('uiScale') ?? 100)
const artworkHashCount = Number(params.get('artworkHashes') ?? 64)
// Inert elements beside the list, standing in for the sidebar, transport and
// titlebar content the real app has, to show how cost scales with document size.
const extraDomCount = Number(params.get('extraDom') ?? 0)
// Comma-separated root column ids to show; empty means every column.
const visibleColumns = (params.get('columns') ?? '').split(',').filter(Boolean)
const columnVisible = id => visibleColumns.length === 0 || visibleColumns.includes(id)

// Deterministic so every variant scrolls through identical rows.
let seed = 0x2f6e2b1
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 0x100000000
}
const pick = list => list[Math.floor(random() * list.length)]
const WORDS = ['Night', 'Signal', 'Glass', 'Harbour', 'Static', 'Velvet', 'Northern', 'Paper', 'Second', 'Hollow',
  'Motion', 'Silver', 'Distant', 'Echo', 'Parallel', 'Summer', 'Machine', 'Quiet', 'Golden', 'Low', 'Tide', 'Orbit']
const phrase = (min, max) => Array.from({ length: min + Math.floor(random() * (max - min + 1)) }, () => pick(WORDS)).join(' ')
const GENRES = ['Electronic', 'Ambient', 'Jazz', 'Post-Rock', 'Hip-Hop', 'Classical', 'House', null]
const KEYS = ['Am', 'C', 'F#m', 'Bb', 'Dm', 'E', null]
const FORMATS = ['flac', 'flac', 'flac', 'mp3', 'm4a', 'opus']

const tracks = Array.from({ length: trackCount }, (_, index) => {
  const artistNames = random() < 0.2 ? [phrase(1, 2), phrase(1, 2)] : [phrase(1, 3)]
  const album = phrase(1, 4)
  const channels = random() < 0.04 ? 6 : 2
  return {
    id: index + 1,
    path: `/library/${index}.flac`,
    album_identity_key: `album-${index >> 3}`,
    is_new: random() < 0.02,
    title: phrase(1, 6),
    artist: artistNames.join(', '),
    artist_names: artistNames,
    album,
    album_artist: artistNames[0],
    album_artist_names: [artistNames[0]],
    year: 1970 + Math.floor(random() * 55),
    duration: 90 + Math.floor(random() * 400),
    track_number: 1 + (index % 14),
    disc_number: 1,
    genre: pick(GENRES),
    genres: [],
    artwork_hash: `fixture-art-${(index >> 3) % artworkHashCount}`,
    format: pick(FORMATS),
    sample_rate: 44100,
    bit_depth: 16,
    bitrate: 900,
    channels,
    bpm: random() < 0.8 ? 70 + Math.floor(random() * 100) : null,
    musical_key: pick(KEYS),
    replaygain_track_gain_db: null,
    replaygain_album_gain_db: null,
    source_type: 'local',
    source_id: null,
    source_track_id: null,
    source_path: null,
    is_available: 1,
    availability_reason: null,
    file_created_at: 1_600_000_000_000 + index * 60_000,
    play_count: Math.floor(random() * 40),
    last_played_at: null,
    added_at: 1_600_000_000_000 + index * 60_000
  }
})

const ratings = new Map()
for (const track of tracks) {
  if (random() < 0.35) ratings.set(track.path, { rating: 1 + Math.floor(random() * 9) / 2 })
}

export const usePlayerStore = create(() => ({
  currentTrack: null, playbackState: 'stopped', remoteLoadProgress: null,
  queueItems: [], upcomingQueueIds: [],
  startPlaybackContextByPaths: asyncNoop, enqueueTrackPaths: asyncNoop
}))
export const useAudioSettingsStore = create(() => ({
  playbackOutputMode: 'standard', spatialMode: 'off', spatialStatus: { state: 'idle' },
  spatialLayoutPresetId: null, customVirtualSpeakers: [], logicalOutputChannelCount: 2
}))
export const useUIStore = create(() => ({
  uiScalePercent: uiScale, trackDrag: null,
  startTrackDrag: noop, setTrackDragItems: noop, openSignalShare: noop, setActiveView: noop
}))
export const useLibraryStore = create(() => ({
  favorites: new Set(tracks.filter((_, index) => index % 11 === 0).map(track => track.path)),
  toggleFavorite: asyncNoop,
  showTracklistBpmKey: columnVisible('bpm'), showTracklistGenre: columnVisible('genre'),
  showTracklistPlayCount: columnVisible('play_count'),
  artistBrowseMode: 'canonical',
  getArtwork: async () => null, selectArtist: asyncNoop, selectAlbum: asyncNoop
}))
export const useRatingsStore = create(() => ({ enabled: columnVisible('rating'), ratings, setTrackRating: asyncNoop }))
export const usePlaylistStore = create(() => ({
  playlists: [], addToPlaylist: asyncNoop, createPlaylistWithOptions: asyncNoop,
  removeFromPlaylist: asyncNoop, removePlaylistEntry: asyncNoop, getPlaylistsContainingTracks: async () => []
}))
export const getNormalPlaylists = playlists => playlists
export const useLibraryIntegrityStore = create(() => ({ enabled: false, checkTracks: asyncNoop, singleTrackBusyPaths: [] }))
export const useMetadataEditorStore = create(() => ({ openPanel: noop, closePanel: noop }))
export const useLyricsEditorStore = create(() => ({ openPanel: noop, closePanel: noop }))
export const useProviderSyncStore = create(() => ({ notifyError: noop }))
export const useOpenArtistInLibrary = () => noop
export const useOpenAlbumInLibrary = () => noop
// Same URL shape as libraryStore so the harness protocol handler sees real requests.
export const buildArtworkProtocolUrl = (hash, variant) => (
  `astra-artwork://art/${variant === 'thumbnail' ? 'thumb' : variant}/${encodeURIComponent(hash)}`
)

// Stands in for the scopes: a fixed slice of main-thread work every frame,
// which is what turns a slow row mount into a missed frame.
const frameLoadMs = Number(params.get('frameLoadMs') ?? 0)
if (frameLoadMs > 0) {
  window.fixtureFrames = []
  const frame = timestamp => {
    window.fixtureFrames.push(timestamp)
    const start = performance.now()
    while (performance.now() - start < frameLoadMs) { /* busy */ }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

const rootTableLayout = { columns: ROOT_TRACK_COLUMN_ORDER.map(id => ({ id, visible: columnVisible(id) })) }

// Mirrors the real shell's ancestry so the --ui-scale transform and the two
// blurred bars above and below the scroller are part of what gets composited.
export function FixtureApp() {
  const scale = uiScale / 100
  return <div className="app-scale-host" style={{ '--ui-scale': scale, '--ui-scale-size': `${100 / scale}%` }}>
    <div className="app">
      <div className="titlebar">Tracklist scroll benchmark</div>
      <div className="app-body">
        {extraDomCount > 0 && <div style={{ width: 220, flexShrink: 0, overflow: 'hidden' }}>
          {Array.from({ length: extraDomCount }, (_, index) => <span key={index}>{index % 10}</span>)}
        </div>}
        <div className="app-main">
          <div className="app-content">
            <div className="library-panel">
              <div className="library-content">
                <TrackList
                  tracks={tracks}
                  showAddedDate
                  showNewTrackIndicator
                  trackNumberMode="none"
                  enableColumnSorting
                  rootTableLayout={rootTableLayout}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="transport-bar" />
    </div>
  </div>
}
