import { create } from 'zustand'
import { audioEngine } from '../audio/AudioEngine'
import { Track, PlaybackState } from '../types/audio'

interface PlayerStore {
  // State
  currentTrack: Track | null
  playbackState: PlaybackState
  currentTime: number
  duration: number
  volume: number
  isMuted: boolean

  // Actions
  loadTrack: (track: Track, audioData: ArrayBuffer) => Promise<void>
  play: () => Promise<void>
  pause: () => void
  togglePlay: () => Promise<void>
  stop: () => void
  seek: (time: number) => Promise<void>
  setVolume: (volume: number) => void
  toggleMute: () => void

  // Internal
  _initListeners: () => void
  _cleanupListeners: () => void
}

export const usePlayerStore = create<PlayerStore>((set, get) => {
  // Track if listeners are initialized
  let listenersInitialized = false

  return {
    // Initial state
    currentTrack: null,
    playbackState: 'stopped',
    currentTime: 0,
    duration: 0,
    volume: 0.7,
    isMuted: false,

    // Load a track
    loadTrack: async (track: Track, audioData: ArrayBuffer) => {
      // Initialize listeners on first load
      if (!listenersInitialized) {
        get()._initListeners()
      }

      set({ currentTrack: track, playbackState: 'loading' })

      try {
        await audioEngine.loadAudioData(audioData)
        set({ duration: audioEngine.duration })
      } catch (error) {
        console.error('Failed to load track:', error)
        set({ playbackState: 'stopped' })
      }
    },

    // Playback controls
    play: async () => {
      await audioEngine.play()
    },

    pause: () => {
      audioEngine.pause()
    },

    togglePlay: async () => {
      await audioEngine.togglePlay()
    },

    stop: () => {
      audioEngine.stop()
    },

    seek: async (time: number) => {
      await audioEngine.seek(time)
    },

    // Volume controls
    setVolume: (volume: number) => {
      audioEngine.setVolume(volume)
      set({ volume, isMuted: false })
    },

    toggleMute: () => {
      audioEngine.toggleMute()
      set({ isMuted: audioEngine.isMuted })
    },

    // Initialize audio engine event listeners
    _initListeners: () => {
      if (listenersInitialized) return
      listenersInitialized = true

      audioEngine.on('stateChange', (state) => {
        set({ playbackState: state as PlaybackState })
      })

      audioEngine.on('timeUpdate', (time) => {
        set({ currentTime: time as number })
      })

      audioEngine.on('durationChange', (duration) => {
        set({ duration: duration as number })
      })

      audioEngine.on('ended', () => {
        set({ currentTime: 0 })
        // TODO: Play next track in queue
      })

      audioEngine.on('error', (error) => {
        console.error('Audio engine error:', error)
      })

      // Set initial volume
      audioEngine.setVolume(get().volume)
    },

    // Cleanup listeners
    _cleanupListeners: () => {
      // Audio engine handles its own cleanup
      listenersInitialized = false
    }
  }
})
