import React from 'react'
import { create } from 'zustand'
import EQFrequencyResponse from '../../src/renderer/components/eq/EQFrequencyResponse'
import FullscreenAmbientSpectrum from '../../src/renderer/components/layout/FullscreenAmbientSpectrum'
import Sidebar from '../../src/renderer/components/layout/Sidebar'

const noop = () => {}
export const useUIStore = create(set => ({
  uiScalePercent: 100, activeView: 'eq', trackDrag: null,
  setActiveView: activeView => set({ activeView }),
  clearSidebarPlaylistCreateRequest: noop, openCollectionQueueMenu: noop
}))
export const useLibraryStore = create(() => ({
  favoriteTrackPaths: [], trackCacheVersion: 0, resolveTrackPaths: () => [],
  clearSelection: noop, getArtwork: async () => null
}))
export const usePlaylistStore = create(() => ({
  playlists: Array.from({ length: 24 }, (_, i) => ({
    id: i + 1, name: `Playlist ${String(i + 1).padStart(2, '0')}`, kind: 'normal',
    created_at: i, updated_at: i, last_played_at: null,
    custom_cover_hash: null, auto_cover_hash: null, track_count: 12
  })),
  sidebarPinnedPlaylistIds: [1, 2, 3], selectedPlaylistId: null,
  loadPlaylists: noop, moveSidebarPinnedPlaylist: noop, clearSelection: noop, selectPlaylist: noop
}))
export const useGraphStore = create(() => ({ enabled: false, openFullMap: noop }))
export const useListeningStatsStore = create(() => ({ enabled: false }))
export const useVisualizerSettingsStore = create(() => ({ lineColor: '#38bdf8', isRunning: true }))

const spectrum = Float32Array.from({ length: 2048 }, (_, i) => -55 + 18 * Math.sin(i / 85))
export const getEQAnalyzerFrameSnapshot = () => ({
  data: spectrum, sampleRate: 48000, minDecibels: -100, maxDecibels: 0, available: true
})
export const subscribeToEQAnalyzerFrames = listener => {
  const timer = setInterval(listener, 16)
  return () => clearInterval(timer)
}

const initialBand = { id: 'test', type: 'peaking', frequency: 1000, gain: 0, Q: 0.707 }
const useFixtureStore = create(() => ({
  mode: 'eq', band: initialBand, viewWidth: 600, viewHeight: 240
}))
window.fixture = {
  useUIStore, useFixtureStore,
  resetBand: type => useFixtureStore.setState({ band: { ...initialBand, type: type ?? 'peaking' } })
}

export function FixtureApp() {
  const scale = useUIStore(state => state.uiScalePercent) / 100
  const { mode, band, viewWidth, viewHeight } = useFixtureStore()
  return <div className="app-scale-host" style={{ '--ui-scale': scale, '--ui-scale-size': `${100 / scale}%` }}>
    <div className="app">
      {mode === 'spectrum' ? <FullscreenAmbientSpectrum /> : <>
        <div className="titlebar">UI scaling regression fixture</div>
        <div className="app-body">
          <Sidebar />
          <main style={{ padding: 40 }}>
            <h2>Equalizer</h2>
            <div className="eq-response-area" style={{ width: 600, height: 240, minHeight: 0, border: 0 }}>
              <EQFrequencyResponse bands={[band]} enabled selectedBandIndex={0}
                width={viewWidth} height={viewHeight} sampleRate={48000} onBandSelect={() => {}}
                onBandDrag={(_, updates) => useFixtureStore.setState(state => ({ band: { ...state.band, ...updates } }))} />
            </div>
          </main>
        </div>
        <div style={{ height: 'var(--now-playing-height)', flexShrink: 0 }} />
      </>}
    </div>
  </div>
}
