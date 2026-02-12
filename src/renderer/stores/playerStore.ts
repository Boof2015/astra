import { create } from 'zustand'
import { audioEngine } from '../audio/AudioEngine'
import { Track, PlaybackState } from '../types/audio'
import { extractWaveformPeaks } from '../audio/waveformExtractor'
import { useLibraryStore } from './libraryStore'
import { useAudioSettingsStore } from './audioSettingsStore'

interface PlayerStore {
  // State
  currentTrack: Track | null
  playbackState: PlaybackState
  currentTime: number
  duration: number
  volume: number
  isMuted: boolean
  waveformData: Float32Array | null
  ffmpegFallbackNotice: {
    id: number
    trackPath: string
    title: string
    artist: string
  } | null
  outputDelayNotice: {
    id: number
    trackPath: string
    title: string
    artist: string
    delayMs: number
    outputLabel: string
  } | null

  // Queue state
  queue: Track[]
  queueIndex: number
  shuffle: boolean
  repeat: 'none' | 'one' | 'all'
  shuffledIndices: number[]
  shufflePosition: number

  // Actions
  loadTrack: (track: Track, audioData: ArrayBuffer) => Promise<boolean>
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
  getUpcomingTracks: () => Track[]
  getPreviousTracks: () => Track[]
  clearFfmpegFallbackNotice: () => void
  clearOutputDelayNotice: () => void

  // Internal
  _initListeners: () => void
  _cleanupListeners: () => void
  _loadAndPlayTrack: (track: Track, options?: { manualStart?: boolean }) => Promise<void>
  _preBufferNextTrack: () => Promise<void>
  _getNextIndex: () => number
  _generateShuffleOrder: (currentQueueIndex: number) => void
}

// Waveform cache stored outside zustand to avoid re-renders on cache updates
const waveformCache = new Map<string, Float32Array>()
const SLOW_PATH_THRESHOLD_MS = 1500
const OUTPUT_DELAY_NOTICE_THRESHOLD_MS = 120

function logSlowPath(label: string, startTime: number, details: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return
  const elapsed = performance.now() - startTime
  if (elapsed <= SLOW_PATH_THRESHOLD_MS) return
  console.warn(`[perf] ${label} slow path (${Math.round(elapsed)}ms)`, details)
}

export const usePlayerStore = create<PlayerStore>((set, get) => {
  // Track if listeners are initialized
  let listenersInitialized = false
  let ffmpegFallbackNoticeId = 0
  let outputDelayNoticeId = 0
  let pendingManualLoadCueTrack: Track | null = null

  const showFfmpegFallbackNotice = (track: Track) => {
    ffmpegFallbackNoticeId += 1
    set({
      ffmpegFallbackNotice: {
        id: ffmpegFallbackNoticeId,
        trackPath: track.path,
        title: track.title,
        artist: track.artist
      }
    })
  }

  const showOutputDelayNotice = (track: Track) => {
    const audioSettingsState = useAudioSettingsStore.getState()
    const delayMs = Math.round(audioSettingsState.effectiveDelayMs)
    if (delayMs < OUTPUT_DELAY_NOTICE_THRESHOLD_MS) return

    const selectedDeviceLabel = audioSettingsState.selectedDeviceId
      ? audioSettingsState.availableDevices.find((device) => device.deviceId === audioSettingsState.selectedDeviceId)?.label
      : null

    outputDelayNoticeId += 1
    set({
      outputDelayNotice: {
        id: outputDelayNoticeId,
        trackPath: track.path,
        title: track.title,
        artist: track.artist,
        delayMs,
        outputLabel: selectedDeviceLabel ?? 'System Default Output'
      }
    })
  }

  return {
    // Initial state
    currentTrack: null,
    playbackState: 'stopped',
    currentTime: 0,
    duration: 0,
    volume: 0.7,
    isMuted: false,
    waveformData: null,
    ffmpegFallbackNotice: null,
    outputDelayNotice: null,

    // Queue state
    queue: [],
    queueIndex: -1,
    shuffle: false,
    repeat: 'none',
    shuffledIndices: [],
    shufflePosition: 0,

    // Load a track
    loadTrack: async (track: Track, audioData: ArrayBuffer) => {
      const loadStart = performance.now()
      pendingManualLoadCueTrack = null
      // Initialize listeners on first load
      if (!listenersInitialized) {
        get()._initListeners()
      }

      set({
        currentTrack: track,
        playbackState: 'loading',
        waveformData: null,
        currentTime: 0,
        duration: track.duration
      })

      try {
        let usedFfmpegFallback = false
        const decodeStart = performance.now()
        try {
          await audioEngine.loadAudioData(audioData)
        } catch (primaryDecodeError) {
          const fallbackData = await window.electronAPI.decodeAudioWithFfmpeg(track.path)
          if (!fallbackData) {
            throw primaryDecodeError
          }

          usedFfmpegFallback = true
          console.warn(`Primary decode failed for ${track.path}; using FFmpeg compatibility decode.`)
          await audioEngine.loadAudioData(fallbackData)
        }
        const decodeMs = Math.round(performance.now() - decodeStart)
        const detectedChannels = audioEngine.getCurrentTrackChannelCount()
        const resolvedTrack: Track = {
          ...track,
          channels: detectedChannels ?? track.channels
        }
        set({
          duration: audioEngine.duration,
          currentTrack: resolvedTrack,
          currentTime: 0
        })
        if (usedFfmpegFallback) {
          showFfmpegFallbackNotice(resolvedTrack)
        }
        pendingManualLoadCueTrack = resolvedTrack

        // Record recently played
        useLibraryStore.getState().recordPlay(track.path)

        // Pre-buffer next track for gapless playback
        get()._preBufferNextTrack()
        logSlowPath('loadTrack', loadStart, {
          trackPath: track.path,
          usedFfmpegFallback,
          decodeMs
        })
        return true
      } catch (error) {
        console.error('Failed to load track:', error)
        logSlowPath('loadTrack', loadStart, {
          trackPath: track.path,
          failed: true
        })
        set({ playbackState: 'stopped' })
        pendingManualLoadCueTrack = null
        return false
      }
    },

    // Playback controls
    play: async () => {
      if (pendingManualLoadCueTrack) {
        showOutputDelayNotice(pendingManualLoadCueTrack)
        pendingManualLoadCueTrack = null
      }
      await audioEngine.play()
    },

    pause: () => {
      audioEngine.pause()
    },

    togglePlay: async () => {
      await audioEngine.togglePlay()
    },

    stop: () => {
      pendingManualLoadCueTrack = null
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
      const { shuffle } = get()
      set({ queue: tracks, queueIndex: startIndex })

      if (shuffle) {
        get()._generateShuffleOrder(startIndex)
      } else {
        set({ shuffledIndices: [], shufflePosition: 0 })
      }
    },

    addToQueue: (track: Track) => {
      const state = get()
      const newQueue = [...state.queue, track]
      const newTrackIndex = newQueue.length - 1

      if (state.shuffle && state.shuffledIndices.length > 0) {
        const insertableStart = state.shufflePosition + 1
        const insertableRange = state.shuffledIndices.length + 1 - insertableStart
        const insertPos = insertableStart + Math.floor(Math.random() * insertableRange)
        const newShuffled = [...state.shuffledIndices]
        newShuffled.splice(insertPos, 0, newTrackIndex)
        set({ queue: newQueue, shuffledIndices: newShuffled })
      } else {
        set({ queue: newQueue })
      }
    },

    addToQueueNext: (track: Track) => {
      const state = get()
      const newQueue = [...state.queue]
      const insertionPoint = state.queueIndex + 1
      newQueue.splice(insertionPoint, 0, track)

      if (state.shuffle && state.shuffledIndices.length > 0) {
        // Increment indices >= insertion point (they shifted in the queue array)
        const newShuffled = state.shuffledIndices.map(idx =>
          idx >= insertionPoint ? idx + 1 : idx
        )
        // Insert the new track right after current in shuffle order
        newShuffled.splice(state.shufflePosition + 1, 0, insertionPoint)
        set({ queue: newQueue, shuffledIndices: newShuffled })
      } else {
        set({ queue: newQueue })
      }

      audioEngine.clearNextBuffer()
      get()._preBufferNextTrack()
    },

    removeFromQueue: (index: number) => {
      const state = get()
      if (index < 0 || index >= state.queue.length) return

      const newQueue = state.queue.filter((_, i) => i !== index)
      let newQueueIndex = state.queueIndex

      if (index < state.queueIndex) {
        newQueueIndex = state.queueIndex - 1
      } else if (index === state.queueIndex) {
        if (newQueueIndex >= newQueue.length) {
          newQueueIndex = newQueue.length - 1
        }
      }

      if (state.shuffle && state.shuffledIndices.length > 0) {
        const removedShufflePos = state.shuffledIndices.indexOf(index)
        let newShuffled = state.shuffledIndices.filter(idx => idx !== index)
        newShuffled = newShuffled.map(idx => idx > index ? idx - 1 : idx)

        let newShufflePos = state.shufflePosition
        if (removedShufflePos !== -1 && removedShufflePos < state.shufflePosition) {
          newShufflePos = state.shufflePosition - 1
        }
        if (newShufflePos >= newShuffled.length) {
          newShufflePos = Math.max(0, newShuffled.length - 1)
        }

        set({
          queue: newQueue,
          queueIndex: newQueueIndex,
          shuffledIndices: newShuffled,
          shufflePosition: newShufflePos
        })
      } else {
        set({ queue: newQueue, queueIndex: newQueueIndex })
      }

      audioEngine.clearNextBuffer()
      get()._preBufferNextTrack()
    },

    moveInQueue: (fromIndex: number, toIndex: number) => {
      const state = get()
      if (fromIndex === toIndex) return

      if (state.shuffle && state.shuffledIndices.length > 0) {
        // When shuffle is on, reorder within shuffledIndices
        if (fromIndex < 0 || fromIndex >= state.shuffledIndices.length) return
        if (toIndex < 0 || toIndex >= state.shuffledIndices.length) return

        const newShuffled = [...state.shuffledIndices]
        const [removed] = newShuffled.splice(fromIndex, 1)
        newShuffled.splice(toIndex, 0, removed)

        let newShufflePos = state.shufflePosition
        if (state.shufflePosition === fromIndex) {
          newShufflePos = toIndex
        } else if (fromIndex < state.shufflePosition && toIndex >= state.shufflePosition) {
          newShufflePos = state.shufflePosition - 1
        } else if (fromIndex > state.shufflePosition && toIndex <= state.shufflePosition) {
          newShufflePos = state.shufflePosition + 1
        }

        set({ shuffledIndices: newShuffled, shufflePosition: newShufflePos })

        audioEngine.clearNextBuffer()
        get()._preBufferNextTrack()
      } else {
        // Original sequential reorder
        if (fromIndex < 0 || fromIndex >= state.queue.length) return
        if (toIndex < 0 || toIndex >= state.queue.length) return

        const newQueue = [...state.queue]
        const [removed] = newQueue.splice(fromIndex, 1)
        newQueue.splice(toIndex, 0, removed)

        let newIndex = state.queueIndex
        if (state.queueIndex === fromIndex) {
          newIndex = toIndex
        } else if (fromIndex < state.queueIndex && toIndex >= state.queueIndex) {
          newIndex = state.queueIndex - 1
        } else if (fromIndex > state.queueIndex && toIndex <= state.queueIndex) {
          newIndex = state.queueIndex + 1
        }

        set({ queue: newQueue, queueIndex: newIndex })

        const oldNextIndex = state.queueIndex + 1
        const newNextIndex = newIndex + 1
        if (fromIndex === oldNextIndex || toIndex === oldNextIndex ||
            fromIndex === newNextIndex || toIndex === newNextIndex) {
          audioEngine.clearNextBuffer()
          get()._preBufferNextTrack()
        }
      }
    },

    clearQueue: () => {
      audioEngine.clearNextBuffer()
      set({ queue: [], queueIndex: -1, shuffledIndices: [], shufflePosition: 0 })
    },

    // Generate a shuffled playback order with the current track at position 0
    _generateShuffleOrder: (currentQueueIndex: number) => {
      const { queue } = get()
      if (queue.length === 0) {
        set({ shuffledIndices: [], shufflePosition: 0 })
        return
      }

      const indices = queue.map((_, i) => i).filter(i => i !== currentQueueIndex)

      // Fisher-Yates shuffle
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]]
      }

      set({ shuffledIndices: [currentQueueIndex, ...indices], shufflePosition: 0 })
    },

    // Get upcoming tracks in the correct display order
    getUpcomingTracks: () => {
      const { queue, queueIndex, shuffle, shuffledIndices, shufflePosition } = get()
      if (queue.length === 0) return []

      if (shuffle && shuffledIndices.length > 0) {
        return shuffledIndices
          .slice(shufflePosition + 1)
          .map(idx => queue[idx])
          .filter(Boolean)
      }
      return queue.slice(queueIndex + 1)
    },

    // Get previously played tracks in the correct display order
    getPreviousTracks: () => {
      const { queue, queueIndex, shuffle, shuffledIndices, shufflePosition } = get()
      if (queue.length === 0) return []

      if (shuffle && shuffledIndices.length > 0) {
        return shuffledIndices
          .slice(0, shufflePosition)
          .map(idx => queue[idx])
          .filter(Boolean)
      }
      return queue.slice(0, queueIndex)
    },

    clearFfmpegFallbackNotice: () => {
      set({ ffmpegFallbackNotice: null })
    },

    clearOutputDelayNotice: () => {
      set({ outputDelayNotice: null })
    },

    // Get the next index based on shuffle/repeat settings
    _getNextIndex: () => {
      const { queue, queueIndex, repeat, shuffle, shuffledIndices, shufflePosition } = get()
      if (queue.length === 0) return -1

      if (repeat === 'one') {
        return queueIndex
      }

      if (shuffle && shuffledIndices.length > 0) {
        const nextPos = shufflePosition + 1
        if (nextPos >= shuffledIndices.length) {
          if (repeat === 'all') {
            // Will re-shuffle at transition time, return first non-current track
            const indices = queue.map((_, i) => i).filter(i => i !== queueIndex)
            return indices.length > 0 ? indices[Math.floor(Math.random() * indices.length)] : queueIndex
          }
          return -1
        }
        return shuffledIndices[nextPos]
      }

      const nextIndex = queueIndex + 1
      if (nextIndex >= queue.length) {
        return repeat === 'all' ? 0 : -1
      }
      return nextIndex
    },

    playNext: async () => {
      const { shuffle, shuffledIndices, shufflePosition, repeat } = get()
      const nextIndex = get()._getNextIndex()
      if (nextIndex === -1) return

      if (shuffle && shuffledIndices.length > 0 && repeat !== 'one') {
        const nextPos = shufflePosition + 1
        if (nextPos >= shuffledIndices.length && repeat === 'all') {
          // Re-shuffle for new cycle
          get()._generateShuffleOrder(nextIndex)
          set({ shufflePosition: 0 })
        } else {
          set({ shufflePosition: nextPos })
        }
      }

      set({ queueIndex: nextIndex })
      await get()._loadAndPlayTrack(get().queue[nextIndex])
    },

    playPrevious: async () => {
      const { queue, queueIndex, currentTime, shuffle, shuffledIndices, shufflePosition } = get()
      if (queue.length === 0) return

      // If more than 3 seconds into track, restart it
      if (currentTime > 3) {
        await audioEngine.seek(0)
        return
      }

      if (shuffle && shuffledIndices.length > 0) {
        if (shufflePosition <= 0) {
          // At beginning of shuffle, wrap to end
          const prevPos = shuffledIndices.length - 1
          set({ shufflePosition: prevPos, queueIndex: shuffledIndices[prevPos] })
          await get()._loadAndPlayTrack(queue[shuffledIndices[prevPos]])
        } else {
          const prevPos = shufflePosition - 1
          set({ shufflePosition: prevPos, queueIndex: shuffledIndices[prevPos] })
          await get()._loadAndPlayTrack(queue[shuffledIndices[prevPos]])
        }
      } else {
        let prevIndex = queueIndex - 1
        if (prevIndex < 0) {
          prevIndex = queue.length - 1
        }
        set({ queueIndex: prevIndex })
        await get()._loadAndPlayTrack(queue[prevIndex])
      }
    },

    playTrackAt: async (index: number) => {
      const { queue, shuffle, shuffledIndices, _loadAndPlayTrack } = get()
      if (index < 0 || index >= queue.length) return

      set({ queueIndex: index })

      if (shuffle && shuffledIndices.length > 0) {
        const posInShuffle = shuffledIndices.indexOf(index)
        if (posInShuffle !== -1) {
          set({ shufflePosition: posInShuffle })
        }
      }

      await _loadAndPlayTrack(queue[index], { manualStart: true })
    },

    toggleShuffle: () => {
      const { shuffle, queueIndex } = get()
      const newShuffle = !shuffle

      if (newShuffle) {
        set({ shuffle: true })
        get()._generateShuffleOrder(queueIndex)
      } else {
        set({ shuffle: false, shuffledIndices: [], shufflePosition: 0 })
      }

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
    _loadAndPlayTrack: async (track: Track, options = {}) => {
      const loadStart = performance.now()
      const manualStart = Boolean(options.manualStart)
      pendingManualLoadCueTrack = null
      // Initialize listeners if needed
      if (!listenersInitialized) {
        get()._initListeners()
      }

      set({
        currentTrack: track,
        playbackState: 'loading',
        waveformData: null,
        currentTime: 0,
        duration: track.duration
      })

      try {
        const fileLoadStart = performance.now()
        // Load audio file from path
        const result = await window.electronAPI.loadAudioFile(track.path, { metadataMode: 'none' })
        const fileLoadMs = Math.round(performance.now() - fileLoadStart)
        if (!result) {
          console.error('Failed to load audio file:', track.path)
          logSlowPath('queueLoadAndPlayTrack', loadStart, {
            trackPath: track.path,
            failed: true,
            stage: 'fileLoad'
          })
          set({ playbackState: 'stopped' })
          return
        }

        let usedFfmpegFallback = false
        const decodeStart = performance.now()
        try {
          await audioEngine.loadAudioData(result.data)
        } catch (primaryDecodeError) {
          const fallbackData = await window.electronAPI.decodeAudioWithFfmpeg(track.path)
          if (!fallbackData) {
            throw primaryDecodeError
          }

          usedFfmpegFallback = true
          console.warn(`Primary decode failed for ${track.path}; using FFmpeg compatibility decode.`)
          await audioEngine.loadAudioData(fallbackData)
        }
        const decodeMs = Math.round(performance.now() - decodeStart)
        const detectedChannels = audioEngine.getCurrentTrackChannelCount()
        const resolvedTrack: Track = {
          ...track,
          title: result.metadata?.title ?? track.title,
          artist: result.metadata?.artist ?? track.artist,
          album: result.metadata?.album ?? track.album,
          duration: result.metadata?.duration ?? track.duration,
          channels: detectedChannels ?? result.metadata?.channels ?? track.channels,
          codec: result.metadata?.codec ?? track.codec,
          codecProfile: result.metadata?.codecProfile ?? track.codecProfile,
          isAtmosJoc: result.metadata?.isAtmosJoc ?? track.isAtmosJoc
        }
        set({
          duration: audioEngine.duration,
          currentTrack: resolvedTrack,
          currentTime: 0
        })
        if (usedFfmpegFallback) {
          showFfmpegFallbackNotice(resolvedTrack)
        }
        if (manualStart) {
          showOutputDelayNotice(resolvedTrack)
        }
        await audioEngine.play()

        // Record recently played
        useLibraryStore.getState().recordPlay(track.path)

        // Pre-buffer next track for gapless playback
        get()._preBufferNextTrack()
        logSlowPath('queueLoadAndPlayTrack', loadStart, {
          trackPath: track.path,
          fileLoadMs,
          decodeMs,
          usedFfmpegFallback
        })
      } catch (error) {
        console.error('Failed to load track:', error)
        logSlowPath('queueLoadAndPlayTrack', loadStart, {
          trackPath: track.path,
          failed: true
        })
        set({ playbackState: 'stopped' })
      }
    },

    // Pre-buffer the next track for gapless playback
    _preBufferNextTrack: async () => {
      const bufferStart = performance.now()
      const { queue, repeat } = get()

      if (repeat === 'one') {
        return
      }

      const nextIndex = get()._getNextIndex()
      if (nextIndex < 0 || nextIndex >= queue.length) return

      const nextTrack = queue[nextIndex]

      try {
        const result = await window.electronAPI.loadAudioFile(nextTrack.path, { metadataMode: 'none' })
        // Re-check repeat mode after async gap — may have changed to 'one'
        if (get().repeat === 'one') {
          return
        }
        if (result) {
          await audioEngine.preBufferNext(result.data)
        }
        logSlowPath('preBufferNextTrack', bufferStart, {
          trackPath: nextTrack.path,
          loaded: Boolean(result)
        })
      } catch (error) {
        console.error('Failed to pre-buffer next track:', error)
        logSlowPath('preBufferNextTrack', bufferStart, {
          trackPath: nextTrack.path,
          failed: true
        })
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

      audioEngine.on('bufferReady', (buffer) => {
        const track = get().currentTrack
        if (!track || !buffer) return

        const cached = waveformCache.get(track.path)
        if (cached) {
          set({ waveformData: cached })
          return
        }

        const peaks = extractWaveformPeaks(buffer as AudioBuffer)
        waveformCache.set(track.path, peaks)
        set({ waveformData: peaks })
      })

      // Handle gapless transition - advance queue without reloading
      audioEngine.on('gaplessTransition', () => {
        const { queue, queueIndex, repeat, shuffle, shuffledIndices, shufflePosition } = get()

        let nextIndex: number
        let newShufflePosition = shufflePosition

        if (repeat === 'one') {
          // Safety net: AudioEngine already swapped to the wrong buffer.
          // Reload the correct track to fix audio/UI desync.
          const correctTrack = queue[queueIndex]
          if (correctTrack) {
            get()._loadAndPlayTrack(correctTrack)
          }
          return
        } else if (shuffle && shuffledIndices.length > 0) {
          const nextPos = shufflePosition + 1
          if (nextPos >= shuffledIndices.length) {
            if (repeat === 'all') {
              // Re-shuffle for next cycle
              get()._generateShuffleOrder(queueIndex)
              const newState = get()
              nextIndex = newState.shuffledIndices[1] !== undefined ? newState.shuffledIndices[1] : newState.shuffledIndices[0]
              newShufflePosition = 1
            } else {
              return
            }
          } else {
            nextIndex = shuffledIndices[nextPos]
            newShufflePosition = nextPos
          }
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
            currentTime: 0,
            shufflePosition: newShufflePosition
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
