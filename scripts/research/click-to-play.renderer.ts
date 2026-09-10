import { useLibraryStore, type DbTrack } from '../../src/renderer/stores/libraryStore'
import { usePlayerStore } from '../../src/renderer/stores/playerStore'
import { useAudioSettingsStore } from '../../src/renderer/stores/audioSettingsStore'
import { audioEngine } from '../../src/renderer/audio/AudioEngine'

type Case = { path: string; alternatePath?: string; duration: number; channels: number; size: number; normalization: string; controlled?: boolean }
let paths: string[] = []
let alternatePaths: string[] = []
let clickCount = 0
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const realLoad = usePlayerStore.getState()._loadAndPlayTrack
let controlledLoadAt = 0

const benchmark = {
  async setup(config: Case) {
    const tracks = Array.from({ length: config.size }, (_, i) => ({
      id: i + 1, path: i === config.size - 1 ? config.path : `/benchmark/track-${i}.flac`,
      title: `Benchmark track ${i}`, artist: 'Synthetic fixture', artist_names: ['Synthetic fixture'],
      album: 'Playback benchmark', album_artist: 'Synthetic fixture', album_artist_names: ['Synthetic fixture'],
      album_identity_key: 'playback-benchmark', duration: config.duration, track_number: i + 1,
      format: config.path.split('.').pop(), sample_rate: 48000, channels: config.channels,
      source_type: 'local', is_available: 1, genres: [],
      replaygain_track_gain_db: config.normalization === 'replaygain' ? -3 : null
    } as unknown as DbTrack))
    paths = tracks.map((track) => track.path)
    alternatePaths = [...paths]
    if (config.alternatePath) {
      alternatePaths[alternatePaths.length - 1] = config.alternatePath
      tracks.push({ ...tracks[tracks.length - 1], path: config.alternatePath })
    }
    clickCount = 0
    useLibraryStore.setState({ trackByPath: new Map(tracks.map((track) => [track.path, track])) })
    useAudioSettingsStore.getState().setNormalizationEnabled(config.normalization !== 'disabled')
    useAudioSettingsStore.getState().setReplayGainMode('track')
    audioEngine.setReplayGainEnabled(config.normalization === 'replaygain')
    usePlayerStore.setState({
      _loadAndPlayTrack: config.controlled ? async () => {
        controlledLoadAt = performance.now()
        return 'loaded'
      } : realLoad
    })
    await frame()
    await frame()
  },
  async click() {
    // A real DOM click with a loading indicator provides a frame-opportunity
    // measurement independent of the diagnostic loading-state timestamp.
    const button = document.createElement('button')
    button.textContent = 'Benchmark play'
    Object.assign(button.style, { position: 'fixed', top: '0', left: '0', zIndex: '999999' })
    document.body.append(button)
    let started = 0
    let loadingStateMs: number | null = null
    let feedbackFrameMs: number | null = null
    let loadDone!: Promise<void>
    const unsub = usePlayerStore.subscribe((state, previous) => {
      if (state.playbackState === 'loading' && previous.playbackState !== 'loading') {
        loadingStateMs = performance.now() - started
        button.textContent = 'Loading…'
        requestAnimationFrame(() => requestAnimationFrame(() => {
          feedbackFrameMs = performance.now() - started
        }))
      }
    })
    button.onclick = () => {
      started = performance.now()
      loadDone = usePlayerStore.getState().startPlaybackContextByPaths(clickCount++ % 2 ? alternatePaths : paths, paths.length - 1)
    }
    button.click()
    await loadDone
    const commandFinishedMs = performance.now() - started
    await frame()
    await frame()
    unsub()
    button.remove()
    const state = usePlayerStore.getState()
    const result = {
      commandFinishedMs, controlledLoadMs: controlledLoadAt > started ? controlledLoadAt - started : null,
      loadingStateMs, feedbackFrameMs, state: state.playbackState, queueSize: state.queueItems.length,
      channels: audioEngine.getCurrentTrackChannelCount(), engine: audioEngine.getLastLoadTimings()
    }
    await frame()
    return result
  },
  async compatibility(config: Case & { outputMode: 'standard' | 'exclusive' | 'bitperfect' }) {
    await benchmark.setup(config)
    await useAudioSettingsStore.getState().setPlaybackOutputMode(config.outputMode)
    const waitFor = async (test: () => boolean, label: string, timeout = 8000) => {
      const started = performance.now()
      while (!test()) {
        if (performance.now() - started > timeout) throw new Error(`Timed out: ${label}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    const first = config.path
    const second = config.alternatePath!
    const state = () => usePlayerStore.getState()
    const checks: string[] = []
    const assert = (condition: boolean, label: string) => {
      if (!condition) throw new Error(label)
      checks.push(label)
    }
    assert(audioEngine.getPlaybackOutputMode() === config.outputMode, 'requested output mode active')
    await state().startPlaybackContextByPaths([first, second], 0)
    assert(state().playbackState === 'playing', 'cold playback')
    await state().seek(1)
    assert(audioEngine.currentTime >= 0.9, 'seek')
    await state()._preBufferNextTrack()
    await waitFor(() => audioEngine.hasNextBuffered, 'next prebuffer')
    assert(audioEngine.nextBufferedTrackPath === second, 'next track prebuffered')
    await state().playNext()
    assert(state().currentTrack?.path === second && state().playbackState === 'playing', 'manual next promotion')
    state().pause()
    await waitFor(() => state().playbackState === 'paused', 'pause')
    await state().play()
    assert(state().playbackState === 'playing', 'resume')
    let gaplessEvents = 0
    const unsubscribe = audioEngine.on('gaplessTransition', () => { gaplessEvents++ })
    await state().startPlaybackContextByPaths([first, second], 0)
    await state().seek(config.duration - 1)
    await state()._preBufferNextTrack()
    await waitFor(() => state().currentTrack?.path === second, 'natural gapless transition')
    unsubscribe()
    assert(gaplessEvents > 0, 'natural gapless event')
    state().stop()
    await waitFor(() => state().playbackState === 'stopped', 'stop')
    assert(state().playbackState === 'stopped', 'stop')
    return { checks, outputMode: audioEngine.getPlaybackOutputMode(), gaplessEvents }
  }
}
Object.assign(window, { astraPlaybackBenchmark: benchmark })
