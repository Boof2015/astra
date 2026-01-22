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
  _preBufferNextTrack: () => Promise<void>
  _getNextIndex: () => number
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

        // Pre-buffer next track for gapless playback
        get()._preBufferNextTrack()
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
      // Pre-buffer will be triggered after track loads
    },

    addToQueue: (track: Track) => {
      set((state) => ({ queue: [...state.queue, track] }))
    },

    addToQueueNext: (track: Track) => {
      const state = get()
      const newQueue = [...state.queue]
      // Insert after current track
      newQueue.splice(state.queueIndex + 1, 0, track)
      set({ queue: newQueue })

      // If we just added the next track, pre-buffer it
      if (state.queueIndex + 1 === state.queueIndex + 1) {
        get()._preBufferNextTrack()
      }
    },

    removeFromQueue: (index: number) => {
      const state = get()
      if (index < 0 || index >= state.queue.length) return

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

      set({ queue: newQueue, queueIndex: newIndex })

      // If we removed the next track, re-buffer
      if (index === state.queueIndex + 1) {
        audioEngine.clearNextBuffer()
        get()._preBufferNextTrack()
      }
    },

    moveInQueue: (fromIndex: number, toIndex: number) => {
      const state = get()
      if (fromIndex === toIndex) return
      if (fromIndex < 0 || fromIndex >= state.queue.length) return
      if (toIndex < 0 || toIndex >= state.queue.length) return

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

      set({ queue: newQueue, queueIndex: newIndex })

      // If the next track changed, re-buffer
      const oldNextIndex = state.queueIndex + 1
      const newNextIndex = newIndex + 1
      if (fromIndex === oldNextIndex || toIndex === oldNextIndex ||
          fromIndex === newNextIndex || toIndex === newNextIndex) {
        audioEngine.clearNextBuffer()
        get()._preBufferNextTrack()
      }
    },

    clearQueue: () => {
      audioEngine.clearNextBuffer()
      set({ queue: [], queueIndex: -1 })
    },

    // Get the next index based on shuffle/repeat settings
    _getNextIndex: () => {
      const { queue, queueIndex, repeat, shuffle } = get()
      if (queue.length === 0) return -1

      if (repeat === 'one') {
        return queueIndex
      } else if (shuffle) {
        const availableIndices = queue.map((_, i) => i).filter(i => i !== queueIndex)
        if (availableIndices.length === 0) return -1
        return availableIndices[Math.floor(Math.random() * availableIndices.length)]
      } else {
        const nextIndex = queueIndex + 1
        if (nextIndex >= queue.length) {
          if (repeat === 'all') {
            return 0
          } else {
            return -1
          }
        }
        return nextIndex
      }
    },

    playNext: async () => {
      const nextIndex = get()._getNextIndex()
      if (nextIndex === -1) return
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
      // Re-buffer with new shuffle setting
      audioEngine.clearNextBuffer()
      get()._preBufferNextTrack()
    },

    toggleRepeat: () => {
      set((state) => {
        const modes: Array<'none' | 'one' | 'all'> = ['none', 'all', 'one']
        const currentIndex = modes.indexOf(state.repeat)
        return { repeat: modes[(currentIndex + 1) % modes.length] }
      })
      // Re-buffer with new repeat setting
      audioEngine.clearNextBuffer()
      get()._preBufferNextTrack()
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

        // Pre-buffer next track for gapless playback
        get()._preBufferNextTrack()
      } catch (error) {
        console.error('Failed to load track:', error)
        set({ playbackState: 'stopped' })
      }
    },

    // Pre-buffer the next track for gapless playback
    _preBufferNextTrack: async () => {
      const { queue, queueIndex, repeat, shuffle } = get()

      // Don't pre-buffer if shuffle is on (we don't know what's next)
      // Actually, we can pre-buffer a random track for shuffle too
      let nextIndex: number

      if (repeat === 'one') {
        // For repeat one, we'll just replay the same track
        // The audio engine handles this by not having a next buffer
        return
      } else if (shuffle) {
        // For shuffle, pick a random next track
        const availableIndices = queue.map((_, i) => i).filter(i => i !== queueIndex)
        if (availableIndices.length === 0) return
        nextIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)]
      } else {
        nextIndex = queueIndex + 1
        if (nextIndex >= queue.length) {
          if (repeat === 'all') {
            nextIndex = 0
          } else {
            // No next track
            return
          }
        }
      }

      if (nextIndex < 0 || nextIndex >= queue.length) return

      const nextTrack = queue[nextIndex]

      try {
        const result = await window.electronAPI.loadAudioFile(nextTrack.path)
        if (result) {
          await audioEngine.preBufferNext(result.data)
        }
      } catch (error) {
        console.error('Failed to pre-buffer next track:', error)
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

      // Handle gapless transition - advance queue without reloading
      audioEngine.on('gaplessTransition', () => {
        const { queue, queueIndex, repeat, shuffle } = get()

        let nextIndex: number
        if (repeat === 'one') {
          nextIndex = queueIndex
        } else if (shuffle) {
          // For shuffle, we pre-buffered a random track
          // We need to find which one... for now just advance
          const availableIndices = queue.map((_, i) => i).filter(i => i !== queueIndex)
          if (availableIndices.length === 0) return
          nextIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)]
        } else {
          nextIndex = queueIndex + 1
          if (nextIndex >= queue.length) {
            if (repeat === 'all') {
              nextIndex = 0
            } else {
              return
            }
          }
        }

        if (nextIndex >= 0 && nextIndex < queue.length) {
          const nextTrack = queue[nextIndex]
          set({
            queueIndex: nextIndex,
            currentTrack: nextTrack,
            currentTime: 0
          })

          // Pre-buffer the NEXT next track
          get()._preBufferNextTrack()
        }
      })

      // Handle non-gapless track end (when no next track buffered)
      audioEngine.on('ended', () => {
        set({ currentTime: 0 })
        // Auto-play next track (non-gapless fallback)
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
