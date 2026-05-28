import { create } from 'zustand'
import { audioEngine } from '../audio/AudioEngine'
import type { Track } from '../types/audio'
import type {
  ParallaxAudioChunk,
  ParallaxPairedSink,
  ParallaxPairResponse,
  ParallaxPairingPin,
  ParallaxSinkConnectionConfig,
  ParallaxStatus,
  ParallaxStreamInfo,
  ParallaxTimelineEvent,
  ParallaxTimelineState
} from '../../types/parallax'
import { clampParallaxPlaybackRatePpm } from '../../types/parallax'
import { useAudioSettingsStore } from './audioSettingsStore'

interface ParallaxSettingsStore {
  status: ParallaxStatus | null
  pairedSinks: ParallaxPairedSink[]
  activePairingPin: ParallaxPairingPin | null
  pendingSinkEvent: ParallaxTimelineEvent | null
  latestTimeline: ParallaxTimelineState | null
  isLoading: boolean
  isInitialized: boolean
  errorMessage: string
  init: () => Promise<void>
  refresh: () => Promise<void>
  setHostEnabled: (enabled: boolean) => Promise<ParallaxStatus | null>
  setHostPort: (port: number) => Promise<ParallaxStatus | null>
  createPairingPin: () => Promise<ParallaxPairingPin | null>
  pairWithHost: (baseUrl: string, pin: string, sinkName: string) => Promise<ParallaxPairResponse | null>
  connectSink: (config: ParallaxSinkConnectionConfig) => Promise<ParallaxStatus | null>
  disconnectSink: () => Promise<void>
  revokePairedSink: (id: string) => Promise<void>
  revokeAllPairedSinks: () => Promise<number>
  resetToDefaults: () => Promise<ParallaxStatus | null>
  shouldDelayHostPlayback: (track: Track | null | undefined) => boolean
  prepareHostPlayback: (track: Track) => Promise<ParallaxTimelineState | null>
}

let statusUnsubscribe: (() => void) | null = null
let eventUnsubscribe: (() => void) | null = null
let audioChunkUnsubscribe: (() => void) | null = null
let telemetryTimer: number | null = null
let pendingAudioChunks: ParallaxAudioChunk[] = []

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Failed to update Parallax settings.'
}

function createStreamId(track: Track): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${track.id}`
}

function buildParallaxStreamInfo(
  track: Track,
  streamId: string,
  buffer: AudioBuffer
): Omit<ParallaxStreamInfo, 'chunkFrames' | 'groupLatencyMs' | 'createdAt'> {
  return {
    streamId,
    trackId: track.id,
    trackPath: track.path,
    title: track.title,
    artist: track.artist,
    album: track.album,
    sampleRate: buffer.sampleRate,
    channels: Math.max(1, Math.min(8, buffer.numberOfChannels)),
    durationSeconds: buffer.duration,
    totalFrames: buffer.length
  }
}

function resolveHostNowMs(status: ParallaxStatus | null): number {
  const offsetMs = status?.sink.clockOffsetMs ?? 0
  return performance.timeOrigin + performance.now() + offsetMs
}

function computeRateCorrectionPpm(
  timeline: ParallaxTimelineState,
  stream: ParallaxStreamInfo,
  currentFrame: number,
  status: ParallaxStatus | null
): { driftFrames: number; playbackRatePpm: number } {
  if (timeline.playbackState !== 'playing') {
    return { driftFrames: 0, playbackRatePpm: 0 }
  }

  const hostElapsedSeconds = Math.max(0, (resolveHostNowMs(status) - timeline.startHostTimeMs) / 1000)
  const expectedFrame = timeline.startFrame + Math.floor(hostElapsedSeconds * stream.sampleRate)
  const driftFrames = currentFrame - expectedFrame
  return {
    driftFrames,
    playbackRatePpm: clampParallaxPlaybackRatePpm(-driftFrames * 2)
  }
}

export const useParallaxStore = create<ParallaxSettingsStore>((set, get) => {
  const applyStatus = (status: ParallaxStatus): ParallaxStatus => {
    set({
      status,
      activePairingPin: status.host.activePairingPin,
      errorMessage: ''
    })

    const pending = get().pendingSinkEvent
    if (pending && status.sink.clockOffsetMs !== null) {
      set({ pendingSinkEvent: null })
      void handleSinkEvent(pending)
    }

    return status
  }

  const refreshPairedSinks = async (): Promise<void> => {
    const pairedSinks = await window.electronAPI.parallax.listPairedSinks()
    set({ pairedSinks })
  }

  const ensureTelemetry = () => {
    if (telemetryTimer !== null) return
    telemetryTimer = window.setInterval(() => {
      const status = get().status
      const stream = status?.sink.activeStream ?? null
      const timeline = get().latestTimeline
      if (!status?.sink.connected || !stream || !timeline) return

      const snapshot = audioEngine.getParallaxSinkSnapshot()
      const correction = computeRateCorrectionPpm(timeline, stream, snapshot.currentFrame, status)
      audioEngine.setParallaxSinkPlaybackRate(correction.playbackRatePpm)
      void window.electronAPI.parallax.publishSinkTelemetry({
        streamId: snapshot.streamId,
        bufferedMs: stream.sampleRate > 0 ? (snapshot.bufferedFrames / stream.sampleRate) * 1000 : 0,
        driftFrames: correction.driftFrames,
        rttMs: status.sink.rttMs,
        underruns: snapshot.underruns,
        playbackRatePpm: correction.playbackRatePpm,
        reportedAtMs: Date.now()
      })
    }, 1000)
  }

  const ensureSubscriptions = () => {
    if (!statusUnsubscribe) {
      statusUnsubscribe = window.electronAPI.parallax.onStatus((status) => {
        applyStatus(status)
        void refreshPairedSinks().catch((error) => {
          set({ errorMessage: toErrorMessage(error) })
        })
      })
    }

    if (!eventUnsubscribe) {
      eventUnsubscribe = window.electronAPI.parallax.onEvent((event) => {
        void handleSinkEvent(event)
      })
    }

    if (!audioChunkUnsubscribe) {
      audioChunkUnsubscribe = window.electronAPI.parallax.onAudioChunk((chunk) => {
        if (audioEngine.getParallaxSinkSnapshot().streamId !== chunk.streamId) {
          pendingAudioChunks = [...pendingAudioChunks, chunk].slice(-256)
          return
        }
        audioEngine.appendParallaxSinkAudioChunk(chunk)
      })
    }

    ensureTelemetry()
  }

  const fetchAll = async (): Promise<ParallaxStatus> => {
    const status = await window.electronAPI.parallax.getStatus()
    ensureSubscriptions()
    applyStatus(status)
    await refreshPairedSinks()
    return status
  }

  const handleSinkEvent = async (event: ParallaxTimelineEvent): Promise<void> => {
    const status = get().status
    if (event.type === 'stop') {
      set({ latestTimeline: null, pendingSinkEvent: null })
      pendingAudioChunks = []
      audioEngine.stopParallaxSinkPlayback()
      return
    }

    const timeline = event.type === 'stream-start' ? event.timeline : event.timeline
    if (event.type === 'stream-start') {
      if (audioEngine.getParallaxSinkSnapshot().streamId !== event.stream.streamId) {
        await audioEngine.loadParallaxSinkStream(event.stream)
      }
      const bufferedChunks = pendingAudioChunks.filter((chunk) => chunk.streamId === event.stream.streamId)
      pendingAudioChunks = pendingAudioChunks.filter((chunk) => chunk.streamId !== event.stream.streamId)
      for (const chunk of bufferedChunks) {
        audioEngine.appendParallaxSinkAudioChunk(chunk)
      }
    }

    if (status?.sink.clockOffsetMs === null || status?.sink.clockOffsetMs === undefined) {
      set({ pendingSinkEvent: event })
      return
    }

    set({ latestTimeline: timeline })
    audioEngine.applyParallaxTimelineFromHostClock(timeline, status.sink.clockOffsetMs, 0)
  }

  return {
    status: null,
    pairedSinks: [],
    activePairingPin: null,
    pendingSinkEvent: null,
    latestTimeline: null,
    isLoading: false,
    isInitialized: false,
    errorMessage: '',

    init: async () => {
      if (get().isInitialized) return
      set({ isLoading: true })
      try {
        await fetchAll()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      } finally {
        set({ isLoading: false, isInitialized: true })
      }
    },

    refresh: async () => {
      set({ isLoading: true })
      try {
        await fetchAll()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      } finally {
        set({ isLoading: false })
      }
    },

    setHostEnabled: async (enabled) => {
      set({ isLoading: true })
      try {
        const status = await window.electronAPI.parallax.setHostEnabled(enabled)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      } finally {
        set({ isLoading: false })
      }
    },

    setHostPort: async (port) => {
      set({ isLoading: true })
      try {
        const status = await window.electronAPI.parallax.setHostPort(port)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      } finally {
        set({ isLoading: false })
      }
    },

    createPairingPin: async () => {
      set({ isLoading: true })
      try {
        const pin = await window.electronAPI.parallax.createPairingPin()
        set({ activePairingPin: pin, errorMessage: '' })
        return pin
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      } finally {
        set({ isLoading: false })
      }
    },

    pairWithHost: async (baseUrl, pin, sinkName) => {
      set({ isLoading: true })
      try {
        const response = await window.electronAPI.parallax.pairWithHost(baseUrl, pin, sinkName)
        set({ errorMessage: '' })
        return response
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      } finally {
        set({ isLoading: false })
      }
    },

    connectSink: async (config) => {
      if (useAudioSettingsStore.getState().playbackOutputMode === 'bitperfect') {
        set({ errorMessage: 'Parallax sink mode is only available in Standard output mode.' })
        return null
      }

      set({ isLoading: true })
      try {
        audioEngine.stop()
        const status = await window.electronAPI.parallax.connectSink(config)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      } finally {
        set({ isLoading: false })
      }
    },

    disconnectSink: async () => {
      set({ isLoading: true })
      try {
        await window.electronAPI.parallax.disconnectSink()
        pendingAudioChunks = []
        audioEngine.stopParallaxSinkPlayback()
        set({ latestTimeline: null, pendingSinkEvent: null, errorMessage: '' })
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      } finally {
        set({ isLoading: false })
      }
    },

    revokePairedSink: async (id) => {
      try {
        await window.electronAPI.parallax.revokePairedSink(id)
        await refreshPairedSinks()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      }
    },

    revokeAllPairedSinks: async () => {
      try {
        const revoked = await window.electronAPI.parallax.revokeAllPairedSinks()
        await refreshPairedSinks()
        return revoked
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return 0
      }
    },

    resetToDefaults: async () => {
      set({ isLoading: true })
      try {
        const status = await window.electronAPI.parallax.resetToDefaults()
        pendingAudioChunks = []
        audioEngine.stopParallaxSinkPlayback()
        set({ pairedSinks: [], latestTimeline: null, pendingSinkEvent: null })
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      } finally {
        set({ isLoading: false })
      }
    },

    shouldDelayHostPlayback: (track) => {
      const status = get().status
      if (!track) return false
      if (track.sourceType && track.sourceType !== 'local') return false
      if (useAudioSettingsStore.getState().playbackOutputMode === 'bitperfect') return false
      return Boolean(status?.host.active && status.host.connectedSinkCount > 0)
    },

    prepareHostPlayback: async (track) => {
      if (!get().shouldDelayHostPlayback(track)) return null
      const buffer = audioEngine.getAudioBuffer()
      if (!buffer) return null
      const streamId = createStreamId(track)
      try {
        const timeline = await window.electronAPI.parallax.publishHostStreamStart(
          buildParallaxStreamInfo(track, streamId, buffer)
        )
        void audioEngine.publishCurrentBufferToParallax(streamId, timeline).catch((error) => {
          set({ errorMessage: toErrorMessage(error) })
        })
        return timeline
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    }
  }
})
