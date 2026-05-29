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
import {
  clampParallaxPlaybackRatePpm,
  decideParallaxSinkCorrection,
  PARALLAX_DEFAULT_GROUP_LATENCY_MS,
  PARALLAX_REBUFFER_MARGIN_MS,
  PARALLAX_RESYNC_LEAD_MS,
  PARALLAX_RESYNC_MIN_INTERVAL_MS,
  PARALLAX_SNAP_CONFIRM_TICKS
} from '../../types/parallax'
import { useAudioSettingsStore } from './audioSettingsStore'

interface ParallaxSettingsStore {
  status: ParallaxStatus | null
  pairedSinks: ParallaxPairedSink[]
  activePairingPin: ParallaxPairingPin | null
  pendingSinkEvent: ParallaxTimelineEvent | null
  latestTimeline: ParallaxTimelineState | null
  sinkSnapshot: {
    streamId: string | null
    currentFrame: number
    bufferedFrames: number
    bufferedEndFrame: number
    underruns: number
    playbackRatePpm: number
    starvedFrames: number
    rebuffering: boolean
  }
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
  startHostStreamForCurrentPlayback: (
    track: Track | null | undefined,
    playing: boolean
  ) => Promise<ParallaxTimelineState | null>
  resumeHostPlayback: (track: Track | null | undefined) => Promise<ParallaxTimelineState | null>
  prepareHostSeek: (timeSeconds: number, playing: boolean) => Promise<ParallaxTimelineState | null>
  pauseHostPlayback: () => Promise<void>
  stopHostPlayback: () => Promise<void>
}

let statusUnsubscribe: (() => void) | null = null
let eventUnsubscribe: (() => void) | null = null
let audioChunkUnsubscribe: (() => void) | null = null
let telemetryTimer: number | null = null
let pendingAudioChunks: ParallaxAudioChunk[] = []
let lastHardSyncAtMs = 0
let snapPendingTicks = 0

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

function localNowMs(): number {
  return performance.timeOrigin + performance.now()
}

function buildHostTimeline(
  stream: ParallaxStreamInfo,
  playbackState: ParallaxTimelineState['playbackState'],
  startFrame: number,
  delayMs: number = 0
): ParallaxTimelineState {
  const now = localNowMs()
  return {
    streamId: stream.streamId,
    playbackState,
    startFrame: Math.max(0, Math.min(stream.totalFrames, Math.floor(startFrame))),
    startHostTimeMs: now + Math.max(0, delayMs),
    updatedHostTimeMs: now,
    groupLatencyMs: stream.groupLatencyMs
  }
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
    const serviceError = status.sink.lastError ?? status.host.lastError ?? ''
    set({
      status,
      activePairingPin: status.host.activePairingPin,
      errorMessage: serviceError
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

  const getActiveHostStream = (): ParallaxStreamInfo | null => {
    const status = get().status
    if (!status?.host.active || status.host.connectedSinkCount <= 0) return null
    return status.host.activeStream
  }

  const getHostFrameForTime = (stream: ParallaxStreamInfo, timeSeconds: number): number => {
    if (!Number.isFinite(timeSeconds)) return 0
    return Math.max(0, Math.min(stream.totalFrames, Math.round(timeSeconds * stream.sampleRate)))
  }

  const publishHostTimeline = async (timeline: ParallaxTimelineState): Promise<ParallaxTimelineState> => {
    await window.electronAPI.parallax.publishHostTimeline(timeline)
    return timeline
  }

  const ensureTelemetry = () => {
    if (telemetryTimer !== null) return
    telemetryTimer = window.setInterval(() => {
      const status = get().status
      // Phase 0 diagnostics: when acting as host with a connected sink, report our own output-latency
      // signals to the main process so the host-side telemetry CSV can log both ends in one row.
      if (status?.host.active && status.host.connectedSinkCount > 0) {
        void window.electronAPI.parallax.reportHostLatency(audioEngine.getOutputLatencyMetrics())
      }
      const stream = status?.sink.activeStream ?? null
      const timeline = get().latestTimeline
      const snapshot = audioEngine.getParallaxSinkSnapshot()
      set({ sinkSnapshot: snapshot })
      if (!status?.sink.connected || !stream || !timeline) return

      const now = performance.timeOrigin + performance.now()
      const hasOffset = status.sink.clockOffsetMs !== null && status.sink.clockOffsetMs !== undefined
      const correction = computeRateCorrectionPpm(timeline, stream, snapshot.currentFrame, status)
      // Live host frame (+ lead), the cursor target for both a hard snap and a rebuffer resume.
      const liveTargetFrame = (): number =>
        Math.max(
          0,
          Math.min(
            stream.totalFrames,
            timeline.startFrame +
              Math.floor(((resolveHostNowMs(status) + PARALLAX_RESYNC_LEAD_MS - timeline.startHostTimeMs) * stream.sampleRate) / 1000)
          )
        )

      let appliedPpm = 0
      if (snapshot.rebuffering) {
        // The worklet self-paused after its buffer drained. Hold (no snap/slew) until the buffer
        // covers the live host frame by a safe margin, then re-anchor to live and resume — so the
        // cursor never free-runs into empty data (the underrun spiral that previously killed the sink).
        snapPendingTicks = 0
        const marginFrames = Math.floor((PARALLAX_REBUFFER_MARGIN_MS * stream.sampleRate) / 1000)
        const target = liveTargetFrame()
        if (
          timeline.playbackState === 'playing' &&
          hasOffset &&
          snapshot.bufferedEndFrame >= target + marginFrames
        ) {
          audioEngine.resyncParallaxSinkToHostFrame(target, PARALLAX_RESYNC_LEAD_MS / 1000)
          lastHardSyncAtMs = now
        }
      } else {
        const decision = decideParallaxSinkCorrection(correction.driftFrames, stream.sampleRate)
        const wantsSnap = decision.mode === 'snap' && timeline.playbackState === 'playing' && hasOffset
        snapPendingTicks = wantsSnap ? snapPendingTicks + 1 : 0
        appliedPpm = decision.playbackRatePpm
        if (
          wantsSnap &&
          snapPendingTicks >= PARALLAX_SNAP_CONFIRM_TICKS &&
          now - lastHardSyncAtMs > PARALLAX_RESYNC_MIN_INTERVAL_MS
        ) {
          audioEngine.resyncParallaxSinkToHostFrame(liveTargetFrame(), PARALLAX_RESYNC_LEAD_MS / 1000)
          lastHardSyncAtMs = now
          snapPendingTicks = 0
          appliedPpm = 0
        } else {
          // Slew toward the host. During the pre-snap confirmation window we still apply the full
          // rate correction so a real offset starts closing smoothly; if it was just measurement
          // noise the next tick falls back into the deadzone and no gap is ever produced.
          appliedPpm = wantsSnap
            ? clampParallaxPlaybackRatePpm(-correction.driftFrames * 2)
            : decision.playbackRatePpm
          audioEngine.setParallaxSinkPlaybackRate(appliedPpm)
        }
      }
      const sinkLatency = audioEngine.getOutputLatencyMetrics()
      void window.electronAPI.parallax.publishSinkTelemetry({
        streamId: snapshot.streamId,
        bufferedMs: stream.sampleRate > 0 ? (snapshot.bufferedFrames / stream.sampleRate) * 1000 : 0,
        driftFrames: correction.driftFrames,
        rttMs: status.sink.rttMs,
        underruns: snapshot.underruns,
        playbackRatePpm: appliedPpm,
        reportedAtMs: Date.now(),
        outputLatencyMs: sinkLatency.outputLatencyMs,
        baseLatencyMs: sinkLatency.baseLatencyMs,
        timestampLatencyMs: sinkLatency.timestampLatencyMs,
        rebuffering: snapshot.rebuffering,
        starvedFrames: snapshot.starvedFrames
      })
    }, 1000)
  }

  const applyChunkTimelineIfNeeded = (chunk: ParallaxAudioChunk): void => {
    const status = get().status
    const stream = status?.sink.activeStream
    if (!status?.sink.connected || !stream || stream.streamId !== chunk.streamId) return
    if (status.sink.clockOffsetMs === null || status.sink.clockOffsetMs === undefined) return

    const latestTimeline = get().latestTimeline
    if (latestTimeline?.streamId === chunk.streamId) return
    if (!Number.isFinite(chunk.hostTimeMs) || chunk.hostTimeMs <= 0) return

    const timeline: ParallaxTimelineState = {
      streamId: chunk.streamId,
      playbackState: 'playing',
      startFrame: Math.max(0, Math.floor(chunk.startFrame)),
      startHostTimeMs: chunk.hostTimeMs,
      updatedHostTimeMs: chunk.hostTimeMs,
      groupLatencyMs: stream.groupLatencyMs
    }
    set({ latestTimeline: timeline })
    audioEngine.applyParallaxTimelineFromHostClock(timeline, status.sink.clockOffsetMs, 0)
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
        void handleSinkEvent(event).catch((error) => {
          set({ errorMessage: toErrorMessage(error) })
        })
      })
    }

    if (!audioChunkUnsubscribe) {
      audioChunkUnsubscribe = window.electronAPI.parallax.onAudioChunk((chunk) => {
        if (audioEngine.getParallaxSinkSnapshot().streamId !== chunk.streamId) {
          pendingAudioChunks = [...pendingAudioChunks, chunk].slice(-256)
          return
        }
        audioEngine.appendParallaxSinkAudioChunk(chunk)
        set({ sinkSnapshot: audioEngine.getParallaxSinkSnapshot() })
        applyChunkTimelineIfNeeded(chunk)
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
      pendingAudioChunks = []
      audioEngine.stopParallaxSinkPlayback()
      set({
        latestTimeline: null,
        pendingSinkEvent: null,
        sinkSnapshot: audioEngine.getParallaxSinkSnapshot()
      })
      return
    }

    const timeline = event.type === 'stream-start' ? event.timeline : event.timeline
    if (event.type === 'stream-start') {
      try {
        if (audioEngine.getParallaxSinkSnapshot().streamId !== event.stream.streamId) {
          await audioEngine.loadParallaxSinkStream(event.stream)
        }
      } catch (error) {
        pendingAudioChunks = pendingAudioChunks.filter((chunk) => chunk.streamId !== event.stream.streamId)
        set({
          pendingSinkEvent: null,
          sinkSnapshot: audioEngine.getParallaxSinkSnapshot(),
          errorMessage: toErrorMessage(error)
        })
        return
      }
      const bufferedChunks = pendingAudioChunks.filter((chunk) => chunk.streamId === event.stream.streamId)
      pendingAudioChunks = pendingAudioChunks.filter((chunk) => chunk.streamId !== event.stream.streamId)
      for (const chunk of bufferedChunks) {
        audioEngine.appendParallaxSinkAudioChunk(chunk)
        applyChunkTimelineIfNeeded(chunk)
      }
      set({ sinkSnapshot: audioEngine.getParallaxSinkSnapshot() })
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
    sinkSnapshot: {
      streamId: null,
      currentFrame: 0,
      bufferedFrames: 0,
      bufferedEndFrame: 0,
      underruns: 0,
      playbackRatePpm: 0,
      starvedFrames: 0,
      rebuffering: false
    },
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
        ensureSubscriptions()
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
        set({
          latestTimeline: null,
          pendingSinkEvent: null,
          sinkSnapshot: audioEngine.getParallaxSinkSnapshot(),
          errorMessage: ''
        })
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
        set({
          pairedSinks: [],
          latestTimeline: null,
          pendingSinkEvent: null,
          sinkSnapshot: audioEngine.getParallaxSinkSnapshot()
        })
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
      ensureTelemetry()
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
    },

    startHostStreamForCurrentPlayback: async (track, playing) => {
      // A sink joined while the host is already on a local track but no stream is published yet.
      // Anchor a stream at the host's current position so the sink joins the in-progress song,
      // WITHOUT rescheduling the host's own audio (no playCurrentBufferOnParallaxTimeline call).
      if (!get().shouldDelayHostPlayback(track) || !track) return null
      if (getActiveHostStream()) return null
      ensureTelemetry()
      const buffer = audioEngine.getAudioBuffer()
      if (!buffer) return null
      const streamId = createStreamId(track)
      // While playing, anchor one group-latency ahead on the host's real timeline so the joining
      // sink gets buffering headroom while the host keeps playing seamlessly. While paused, anchor
      // at the current frame (a later resume republishes a fresh playing timeline + chunks).
      const leadSeconds = playing ? PARALLAX_DEFAULT_GROUP_LATENCY_MS / 1000 : 0
      const startFrame = Math.max(
        0,
        Math.min(buffer.length, Math.round((audioEngine.currentTime + leadSeconds) * buffer.sampleRate))
      )
      try {
        const timeline = await window.electronAPI.parallax.publishHostStreamStart(
          buildParallaxStreamInfo(track, streamId, buffer),
          { startFrame, playbackState: playing ? 'playing' : 'paused' }
        )
        if (playing) {
          void audioEngine.publishCurrentBufferToParallax(streamId, timeline).catch((error) => {
            set({ errorMessage: toErrorMessage(error) })
          })
        }
        return timeline
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    resumeHostPlayback: async (track) => {
      const stream = getActiveHostStream()
      if (!stream || !track || stream.trackPath !== track.path) return null
      const timeline = buildHostTimeline(
        stream,
        'playing',
        getHostFrameForTime(stream, audioEngine.currentTime),
        stream.groupLatencyMs
      )
      try {
        await publishHostTimeline(timeline)
        void audioEngine.publishCurrentBufferToParallax(stream.streamId, timeline).catch((error) => {
          set({ errorMessage: toErrorMessage(error) })
        })
        return timeline
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    prepareHostSeek: async (timeSeconds, playing) => {
      const stream = getActiveHostStream()
      if (!stream) return null
      const timeline = buildHostTimeline(
        stream,
        playing ? 'playing' : 'paused',
        getHostFrameForTime(stream, timeSeconds),
        playing ? stream.groupLatencyMs : 0
      )
      try {
        await publishHostTimeline(timeline)
        if (playing) {
          void audioEngine.publishCurrentBufferToParallax(stream.streamId, timeline).catch((error) => {
            set({ errorMessage: toErrorMessage(error) })
          })
        } else {
          audioEngine.cancelParallaxHostPublishing()
        }
        return timeline
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    pauseHostPlayback: async () => {
      const stream = getActiveHostStream()
      if (!stream) return
      const timeline = buildHostTimeline(
        stream,
        'paused',
        getHostFrameForTime(stream, audioEngine.currentTime)
      )
      audioEngine.cancelParallaxHostPublishing()
      try {
        await publishHostTimeline(timeline)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      }
    },

    stopHostPlayback: async () => {
      audioEngine.cancelParallaxHostPublishing()
      try {
        await window.electronAPI.parallax.stopHostStream()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      }
    }
  }
})
