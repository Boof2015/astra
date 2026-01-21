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

  // Queue state
  queue: Track[]
  queueIndex: number
  shuffle: boolean
  repeat: 'none' | 'one' | 'all'

  // Actions
  loadTrack: (track: Track, audioData: ArrayBuffer) => Promise<void>
  play: () => Promise<void>
  pause: () => void
  togglePlay: () => Promise<void>
  stop: () => void
  seek: (time: number) => Promise<void>
  setVolume: (volume: number) => void
  toggleMute: () => void

  // Queue actions
  setQueue: (tracks: Track[], startIndex?: number) => void
  addToQueue: (track: Track) => void
  addToQueueNext: (track: Track) => void
  removeFromQueue: (index: number) => void
  moveInQueue: (fromIndex: number, toIndex: number) => void
  clearQueue: () => void
  playNext: () => Promise<void>
  playPrevious: () => Promise<void>
  playTrackAt: (index: number) => Promise<void>
  toggleShuffle: () => void
  toggleRepeat: () => void

  // Internal
  _initListeners: () => void
  _cleanupListeners: () => void
  _loadAndPlayTrack: (track: Track) => Promise<void>
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

    // Queue state
    queue: [],
    queueIndex: -1,
    shuffle: false,
    repeat: 'none',

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

    // Queue actions
    setQueue: (tracks: Track[], startIndex = 0) => {
      set({ queue: tracks, queueIndex: startIndex })
    },

    addToQueue: (track: Track) => {
      set((state) => ({ queue: [...state.queue, track] }))
    },

    addToQueueNext: (track: Track) => {
      set((state) => {
        const newQueue = [...state.queue]
        // Insert after current track
        newQueue.splice(state.queueIndex + 1, 0, track)
        return { queue: newQueue }
      })
    },

    removeFromQueue: (index: number) => {
      set((state) => {
        if (index < 0 || index >= state.queue.length) return state
        const newQueue = state.queue.filter((_, i) => i !== index)
        let newIndex = state.queueIndex

        // Adjust index if we removed a track before current
        if (index < state.queueIndex) {
          newIndex = state.queueIndex - 1
        } else if (index === state.queueIndex) {
          // If we removed the current track, keep index (will point to next track)
          // But make sure we don't go out of bounds
          if (newIndex >= newQueue.length) {
            newIndex = newQueue.length - 1
          }
        }

        return { queue: newQueue, queueIndex: newIndex }
      })
    },

    moveInQueue: (fromIndex: number, toIndex: number) => {
      set((state) => {
        if (fromIndex === toIndex) return state
        if (fromIndex < 0 || fromIndex >= state.queue.length) return state
        if (toIndex < 0 || toIndex >= state.queue.length) return state

        const newQueue = [...state.queue]
        const [removed] = newQueue.splice(fromIndex, 1)
        newQueue.splice(toIndex, 0, removed)

        // Adjust queueIndex if affected
        let newIndex = state.queueIndex
        if (state.queueIndex === fromIndex) {
          // Moving current track
          newIndex = toIndex
        } else if (fromIndex < state.queueIndex && toIndex >= state.queueIndex) {
          // Moving a track from before to after current
          newIndex = state.queueIndex - 1
        } else if (fromIndex > state.queueIndex && toIndex <= state.queueIndex) {
          // Moving a track from after to before current
          newIndex = state.queueIndex + 1
        }

        return { queue: newQueue, queueIndex: newIndex }
      })
    },

    clearQueue: () => {
      set({ queue: [], queueIndex: -1 })
    },

    playNext: async () => {
      const { queue, queueIndex, repeat, shuffle } = get()
      if (queue.length === 0) return

      let nextIndex: number

      if (repeat === 'one') {
        // Repeat same track
        nextIndex = queueIndex
      } else if (shuffle) {
        // Random track (excluding current)
        const availableIndices = queue.map((_, i) => i).filter(i => i !== queueIndex)
        if (availableIndices.length === 0) return
        nextIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)]
      } else {
        // Next track
        nextIndex = queueIndex + 1
        if (nextIndex >= queue.length) {
          if (repeat === 'all') {
            nextIndex = 0
          } else {
            // End of queue
            return
          }
        }
      }

      await get().playTrackAt(nextIndex)
    },

    playPrevious: async () => {
      const { queue, queueIndex, currentTime } = get()
      if (queue.length === 0) return

      // If more than 3 seconds into track, restart it
      if (currentTime > 3) {
        await audioEngine.seek(0)
        return
      }

      let prevIndex = queueIndex - 1
      if (prevIndex < 0) {
        prevIndex = queue.length - 1 // Wrap to end
      }

      await get().playTrackAt(prevIndex)
    },

    playTrackAt: async (index: number) => {
      const { queue, _loadAndPlayTrack } = get()
      if (index < 0 || index >= queue.length) return

      set({ queueIndex: index })
      await _loadAndPlayTrack(queue[index])
    },

    toggleShuffle: () => {
      set((state) => ({ shuffle: !state.shuffle }))
    },

    toggleRepeat: () => {
      set((state) => {
        const modes: Array<'none' | 'one' | 'all'> = ['none', 'all', 'one']
        const currentIndex = modes.indexOf(state.repeat)
        return { repeat: modes[(currentIndex + 1) % modes.length] }
      })
    },

    // Internal: Load and play a track from queue
    _loadAndPlayTrack: async (track: Track) => {
      // Initialize listeners if needed
      if (!listenersInitialized) {
        get()._initListeners()
      }

      set({ currentTrack: track, playbackState: 'loading' })

      try {
        // Load audio file from path
        const result = await window.electronAPI.loadAudioFile(track.path)
        if (!result) {
          console.error('Failed to load audio file:', track.path)
          set({ playbackState: 'stopped' })
          return
        }

        await audioEngine.loadAudioData(result.data)
        set({ duration: audioEngine.duration })
      } catch (error) {
        console.error('Failed to load track:', error)
        set({ playbackState: 'stopped' })
      }
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
        // Auto-play next track
        get().playNext()
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
