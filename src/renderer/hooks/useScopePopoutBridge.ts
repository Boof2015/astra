import { useEffect, useMemo, useRef } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { isNativeAvailable } from '../audio/native/index'
import { getNormalizedOscilloscopeDisplaySamples } from '../audio/native/oscilloscopeDisplaySamples'
import {
  AnalyzerSilenceClock,
  createMonoSilenceChunk,
  createMonoSilenceChunkWithSampleCount,
  createMultichannelSilenceChunk,
  createStereoSilenceChunk,
  isPlaybackAnalyzerActive,
} from '../audio/visualizerSilence'
import { usePlayerStore } from '../stores/playerStore'
import { useScopePopoutStore } from '../stores/scopePopoutStore'
import { useVisualizerSettingsStore } from '../stores/visualizerSettingsStore'
import { useThemeStore } from '../stores/themeStore'
import { resolveSpectrumHeatColors } from '../audio/visualizers/spectrumHeatPalette'
import { SCOPE_KINDS, type ScopeKind } from '../../types/scopePopout'

const STREAM_INTERVAL_MS = 16

type ResetState = Record<ScopeKind, boolean>

const EMPTY_RESET_STATE: ResetState = {
  spectrum: false,
  oscilloscope: false,
  vectorscope: false,
  spectrogram: false,
  vumeter: false,
  lufsmeter: false,
  waveform: false,
}

function flushScopeQueue(scope: ScopeKind): void {
  switch (scope) {
    case 'spectrum':
      audioEngine.flushPendingSpectrumSamples()
      break
    case 'oscilloscope':
      audioEngine.flushPendingOscilloscopeSamples()
      break
    case 'vectorscope':
      audioEngine.flushPendingVectorscopeSamples()
      break
    case 'spectrogram':
      audioEngine.flushPendingSpectrogramSamples()
      break
    case 'vumeter':
      audioEngine.flushPendingVUMeterSamples()
      break
    case 'lufsmeter':
      audioEngine.flushPendingLUFSMeterSamples()
      break
    case 'waveform':
      audioEngine.flushPendingWaveformSamples()
      break
  }
}

export function useScopePopoutBridge(): void {
  const playbackState = usePlayerStore((s) => s.playbackState)
  const lineColor = useVisualizerSettingsStore((s) => s.lineColor)
  const fftSize = useVisualizerSettingsStore((s) => s.fftSize)
  const spectrogramFftSize = useVisualizerSettingsStore((s) => s.spectrogramFftSize)
  const spectrogramScrollSpeed = useVisualizerSettingsStore((s) => s.spectrogramScrollSpeed)
  const spectrogramClarityMode = useVisualizerSettingsStore((s) => s.spectrogramClarityMode)
  const spectrogramScaleMode = useVisualizerSettingsStore((s) => s.spectrogramScaleMode)
  const spectrogramTiltDbPerOctave = useVisualizerSettingsStore((s) => s.spectrogramTiltDbPerOctave)
  const spectrogramContrast = useVisualizerSettingsStore((s) => s.spectrogramContrast)
  const spectrogramOrientation = useVisualizerSettingsStore((s) => s.spectrogramOrientation)
  const spectrumHeatmap = useVisualizerSettingsStore((s) => s.spectrumHeatmap)
  const spectrumDisplayMode = useVisualizerSettingsStore((s) => s.spectrumDisplayMode)
  const spectrumTiltDbPerOctave = useVisualizerSettingsStore((s) => s.spectrumTiltDbPerOctave)
  const spectrumHeatmapTiltDbPerOctave = useVisualizerSettingsStore((s) => s.spectrumHeatmapTiltDbPerOctave)
  const spectrumSmoothing = useVisualizerSettingsStore((s) => s.spectrumSmoothing)
  const spectrumHeatmapSmoothing = useVisualizerSettingsStore((s) => s.spectrumHeatmapSmoothing)
  const spectrumBarDensity = useVisualizerSettingsStore((s) => s.spectrumBarDensity)
  const spectrumBarGapPercent = useVisualizerSettingsStore((s) => s.spectrumBarGapPercent)
  const spectrumBarCornerRadiusPx = useVisualizerSettingsStore((s) => s.spectrumBarCornerRadiusPx)
  const spectrumShowBarPeaks = useVisualizerSettingsStore((s) => s.spectrumShowBarPeaks)
  const spectrumHeatPalette = useVisualizerSettingsStore((s) => s.spectrumHeatPalette)
  const visualizerTheme = useThemeStore((s) => s.resolvedTokens)
  const waveformScrollSpeed = useVisualizerSettingsStore((s) => s.waveformScrollSpeed)
  const waveformGainDb = useVisualizerSettingsStore((s) => s.waveformGainDb)
  const waveformMultiband = useVisualizerSettingsStore((s) => s.waveformMultiband)
  const pitchLock = useVisualizerSettingsStore((s) => s.pitchLock)
  const oscilloscopeUnderfillEnabled = useVisualizerSettingsStore((s) => s.oscilloscopeUnderfillEnabled)
  const vectorscopeMode = useVisualizerSettingsStore((s) => s.vectorscopeMode)
  const vectorscopeMultiband = useVisualizerSettingsStore((s) => s.vectorscopeMultiband)
  const vuMeterMode = useVisualizerSettingsStore((s) => s.vuMeterMode)
  const vuMeterOrientation = useVisualizerSettingsStore((s) => s.vuMeterOrientation)
  const lufsMeterMode = useVisualizerSettingsStore((s) => s.lufsMeterMode)
  const isVisualizerRunning = useVisualizerSettingsStore((s) => s.isRunning)
  const scopePopoutState = useScopePopoutStore((s) => s.state)
  const setScopePopoutState = useScopePopoutStore((s) => s.setState)
  const nativeVisualizersAvailable = isNativeAvailable()
  const spectrumHeatColors = useMemo(
    () => resolveSpectrumHeatColors(
      spectrumHeatPalette,
      lineColor,
      visualizerTheme.stageBg,
      visualizerTheme.isLight,
    ),
    [lineColor, spectrumHeatPalette, visualizerTheme.isLight, visualizerTheme.stageBg],
  )

  const streamTimerRef = useRef<number | null>(null)
  const resetSentRef = useRef<ResetState>({ ...EMPTY_RESET_STATE })
  const silenceClockRef = useRef<Partial<Record<ScopeKind, AnalyzerSilenceClock>>>({})

  const getSilenceClock = (scope: ScopeKind): AnalyzerSilenceClock => {
    let clock = silenceClockRef.current[scope]
    if (!clock) {
      clock = new AnalyzerSilenceClock()
      silenceClockRef.current[scope] = clock
    }
    return clock
  }

  useEffect(() => {
    let isMounted = true

    void window.electronAPI.scopePopout.getState().then((state) => {
      if (!isMounted) return
      setScopePopoutState(state)
    })

    const unsubscribe = window.electronAPI.scopePopout.onState((state) => {
      setScopePopoutState(state)
    })

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [setScopePopoutState])

  useEffect(() => {
    audioEngine.setVisualizerConsumerDemand('scope-popout-bridge', {
      spectrum: nativeVisualizersAvailable && isVisualizerRunning && scopePopoutState.spectrum,
      oscilloscope: nativeVisualizersAvailable && isVisualizerRunning && scopePopoutState.oscilloscope,
      vectorscope: isVisualizerRunning && scopePopoutState.vectorscope,
      spectrogram: isVisualizerRunning && scopePopoutState.spectrogram,
      vumeter: isVisualizerRunning && scopePopoutState.vumeter,
      lufsmeter: isVisualizerRunning && scopePopoutState.lufsmeter,
      waveform: isVisualizerRunning && scopePopoutState.waveform,
    })

    return () => {
      audioEngine.clearVisualizerConsumerDemand('scope-popout-bridge')
    }
  }, [isVisualizerRunning, nativeVisualizersAvailable, scopePopoutState])

  useEffect(() => {
    if (streamTimerRef.current !== null) {
      window.clearInterval(streamTimerRef.current)
      streamTimerRef.current = null
    }

    for (const scope of SCOPE_KINDS) {
      if (!scopePopoutState[scope]) {
        resetSentRef.current[scope] = false
        silenceClockRef.current[scope]?.reset()
      }
    }

    const poppedScopes = SCOPE_KINDS.filter((scope) => scopePopoutState[scope])
    if (poppedScopes.length === 0) {
      return
    }

    const emitReset = (scope: ScopeKind) => {
      switch (scope) {
        case 'spectrum':
          window.electronAPI.scopePopout.publishChunk({
            scope: 'spectrum',
            capturedAt: Date.now(),
            sampleRate: audioEngine.getSampleRate(),
            monoChunks: [],
            fftSize,
            spectrumDisplayMode,
            spectrumTiltDbPerOctave,
            spectrumHeatmap,
            spectrumHeatmapTiltDbPerOctave,
            spectrumSmoothing,
            spectrumHeatmapSmoothing,
            spectrumBarDensity,
            spectrumBarGapPercent,
            spectrumBarCornerRadiusPx,
            spectrumShowBarPeaks,
            spectrumHeatPalette,
            spectrumHeatColors,
            lineColor,
            reset: true,
          })
          break
        case 'oscilloscope':
          window.electronAPI.scopePopout.publishChunk({
            scope: 'oscilloscope',
            capturedAt: Date.now(),
            sampleRate: audioEngine.getSampleRate(),
            leftChunks: [],
            pitchLock,
            oscilloscopeUnderfillEnabled,
            lineColor,
            reset: true,
          })
          break
        case 'vectorscope':
          window.electronAPI.scopePopout.publishChunk({
            scope: 'vectorscope',
            capturedAt: Date.now(),
            sampleRate: audioEngine.getSampleRate(),
            stereoChunks: [],
            vectorscopeMode,
            vectorscopeMultiband,
            lineColor,
            reset: true,
          })
          break
        case 'spectrogram':
          window.electronAPI.scopePopout.publishChunk({
            scope: 'spectrogram',
            capturedAt: Date.now(),
            sampleRate: audioEngine.getSampleRate(),
            monoChunks: [],
            fftSize: spectrogramFftSize,
            spectrogramScrollSpeed,
            spectrogramClarityMode,
            spectrogramScaleMode,
            spectrogramTiltDbPerOctave,
            spectrogramContrast,
            spectrogramOrientation,
            lineColor,
            reset: true,
          })
          break
        case 'vumeter':
          window.electronAPI.scopePopout.publishChunk({
            scope: 'vumeter',
            capturedAt: Date.now(),
            sampleRate: audioEngine.getSampleRate(),
            channelChunks: [],
            vuMeterMode,
            vuMeterOrientation,
            lineColor,
            reset: true,
          })
          break
        case 'lufsmeter':
          window.electronAPI.scopePopout.publishChunk({
            scope: 'lufsmeter',
            capturedAt: Date.now(),
            sampleRate: audioEngine.getSampleRate(),
            stereoChunks: [],
            lufsMeterMode,
            lineColor,
            reset: true,
          })
          break
        case 'waveform':
          window.electronAPI.scopePopout.publishChunk({
            scope: 'waveform',
            capturedAt: Date.now(),
            sampleRate: audioEngine.getSampleRate(),
            monoChunks: [],
            waveformScrollSpeed,
            waveformGainDb,
            waveformMultiband,
            lineColor,
            reset: true,
          })
          break
      }
      resetSentRef.current[scope] = true
    }

    const emitSilence = (scope: ScopeKind) => {
      flushScopeQueue(scope)

      if ((scope === 'spectrum' || scope === 'oscilloscope') && !nativeVisualizersAvailable) {
        if (!resetSentRef.current[scope]) {
          emitReset(scope)
        }
        return
      }

      const sampleRate = audioEngine.getSampleRate()

      switch (scope) {
        case 'spectrum':
          window.electronAPI.scopePopout.publishChunk({
            scope: 'spectrum',
            capturedAt: Date.now(),
            sampleRate,
            monoChunks: [createMonoSilenceChunk(sampleRate, fftSize)],
            fftSize,
            spectrumDisplayMode,
            spectrumTiltDbPerOctave,
            spectrumHeatmap,
            spectrumHeatmapTiltDbPerOctave,
            spectrumSmoothing,
            spectrumHeatmapSmoothing,
            spectrumBarDensity,
            spectrumBarGapPercent,
            spectrumBarCornerRadiusPx,
            spectrumShowBarPeaks,
            spectrumHeatPalette,
            spectrumHeatColors,
            lineColor,
            reset: false,
          })
          break
        case 'oscilloscope':
          window.electronAPI.scopePopout.publishChunk({
            scope: 'oscilloscope',
            capturedAt: Date.now(),
            sampleRate,
            leftChunks: [createMonoSilenceChunk(sampleRate, getNormalizedOscilloscopeDisplaySamples(sampleRate))],
            pitchLock,
            oscilloscopeUnderfillEnabled,
            lineColor,
            reset: false,
          })
          break
        case 'vectorscope':
          window.electronAPI.scopePopout.publishChunk({
            scope: 'vectorscope',
            capturedAt: Date.now(),
            sampleRate,
            stereoChunks: [createStereoSilenceChunk(sampleRate)],
            vectorscopeMode,
            vectorscopeMultiband,
            lineColor,
            reset: false,
          })
          break
        case 'spectrogram':
          window.electronAPI.scopePopout.publishChunk({
            scope: 'spectrogram',
            capturedAt: Date.now(),
            sampleRate,
            monoChunks: [createMonoSilenceChunkWithSampleCount(getSilenceClock(scope).nextSampleCount(sampleRate))],
            fftSize: spectrogramFftSize,
            spectrogramScrollSpeed,
            spectrogramClarityMode,
            spectrogramScaleMode,
            spectrogramTiltDbPerOctave,
            spectrogramContrast,
            spectrogramOrientation,
            lineColor,
            reset: false,
          })
          break
        case 'vumeter':
          window.electronAPI.scopePopout.publishChunk({
            scope: 'vumeter',
            capturedAt: Date.now(),
            sampleRate,
            channelChunks: [createMultichannelSilenceChunk(sampleRate, audioEngine.getCurrentTrackChannelCount() ?? 2)],
            vuMeterMode,
            vuMeterOrientation,
            lineColor,
            reset: false,
          })
          break
        case 'lufsmeter':
          window.electronAPI.scopePopout.publishChunk({
            scope: 'lufsmeter',
            capturedAt: Date.now(),
            sampleRate,
            stereoChunks: [createStereoSilenceChunk(sampleRate)],
            lufsMeterMode,
            lineColor,
            reset: false,
          })
          break
        case 'waveform':
          window.electronAPI.scopePopout.publishChunk({
            scope: 'waveform',
            capturedAt: Date.now(),
            sampleRate,
            monoChunks: [createMonoSilenceChunkWithSampleCount(getSilenceClock(scope).nextSampleCount(sampleRate))],
            waveformScrollSpeed,
            waveformGainDb,
            waveformMultiband,
            lineColor,
            reset: false,
          })
          break
      }

      resetSentRef.current[scope] = false
    }

    streamTimerRef.current = window.setInterval(() => {
      const shouldStream = isPlaybackAnalyzerActive(playbackState) && isVisualizerRunning
      const shouldPublishSilence = playbackState === 'paused'

      for (const scope of poppedScopes) {
        if (!shouldStream) {
          flushScopeQueue(scope)
          silenceClockRef.current[scope]?.reset()
          if (!resetSentRef.current[scope]) {
            emitReset(scope)
          }
          continue
        }

        if (shouldPublishSilence) {
          emitSilence(scope)
          continue
        }

        if (playbackState === 'playing') {
          silenceClockRef.current[scope]?.reset()
        }

        switch (scope) {
          case 'spectrum': {
            if (!nativeVisualizersAvailable) {
              flushScopeQueue(scope)
              if (!resetSentRef.current[scope]) {
                emitReset(scope)
              }
              continue
            }
            const monoChunks = audioEngine.flushPendingSpectrumSamples()
            if (monoChunks.length === 0) continue
            window.electronAPI.scopePopout.publishChunk({
              scope: 'spectrum',
              capturedAt: Date.now(),
              sampleRate: audioEngine.getSampleRate(),
              monoChunks,
              fftSize,
              spectrumDisplayMode,
              spectrumTiltDbPerOctave,
              spectrumHeatmap,
              spectrumHeatmapTiltDbPerOctave,
              spectrumSmoothing,
              spectrumHeatmapSmoothing,
              spectrumBarDensity,
              spectrumBarGapPercent,
              spectrumBarCornerRadiusPx,
              spectrumShowBarPeaks,
              spectrumHeatPalette,
              spectrumHeatColors,
              lineColor,
              reset: false,
            })
            resetSentRef.current[scope] = false
            break
          }
          case 'oscilloscope': {
            if (!nativeVisualizersAvailable) {
              flushScopeQueue(scope)
              if (!resetSentRef.current[scope]) {
                emitReset(scope)
              }
              continue
            }
            const leftChunks = audioEngine.flushPendingOscilloscopeSamples()
            if (leftChunks.length === 0) continue
            window.electronAPI.scopePopout.publishChunk({
              scope: 'oscilloscope',
              capturedAt: Date.now(),
              sampleRate: audioEngine.getSampleRate(),
              leftChunks,
              pitchLock,
              oscilloscopeUnderfillEnabled,
              lineColor,
              reset: false,
            })
            resetSentRef.current[scope] = false
            break
          }
          case 'vectorscope': {
            const stereoChunks = audioEngine.flushPendingVectorscopeSamples()
            if (stereoChunks.length === 0) continue
            window.electronAPI.scopePopout.publishChunk({
              scope: 'vectorscope',
              capturedAt: Date.now(),
              sampleRate: audioEngine.getSampleRate(),
              stereoChunks,
              vectorscopeMode,
              vectorscopeMultiband,
              lineColor,
              reset: false,
            })
            resetSentRef.current[scope] = false
            break
          }
          case 'spectrogram': {
            const monoChunks = audioEngine.flushPendingSpectrogramSamples()
            if (monoChunks.length === 0) continue
            window.electronAPI.scopePopout.publishChunk({
              scope: 'spectrogram',
              capturedAt: Date.now(),
              sampleRate: audioEngine.getSampleRate(),
              monoChunks,
              fftSize: spectrogramFftSize,
              spectrogramScrollSpeed,
              spectrogramClarityMode,
              spectrogramScaleMode,
              spectrogramTiltDbPerOctave,
              spectrogramContrast,
              spectrogramOrientation,
              lineColor,
              reset: false,
            })
            resetSentRef.current[scope] = false
            break
          }
          case 'vumeter': {
            const channelChunks = audioEngine.flushPendingVUMeterSamples()
            if (channelChunks.length === 0) continue
            window.electronAPI.scopePopout.publishChunk({
              scope: 'vumeter',
              capturedAt: Date.now(),
              sampleRate: audioEngine.getSampleRate(),
              channelChunks,
              vuMeterMode,
              vuMeterOrientation,
              lineColor,
              reset: false,
            })
            resetSentRef.current[scope] = false
            break
          }
          case 'lufsmeter': {
            const stereoChunks = audioEngine.flushPendingLUFSMeterSamples()
            if (stereoChunks.length === 0) continue
            window.electronAPI.scopePopout.publishChunk({
              scope: 'lufsmeter',
              capturedAt: Date.now(),
              sampleRate: audioEngine.getSampleRate(),
              stereoChunks,
              lufsMeterMode,
              lineColor,
              reset: false,
            })
            resetSentRef.current[scope] = false
            break
          }
          case 'waveform': {
            const monoChunks = audioEngine.flushPendingWaveformSamples()
            if (monoChunks.length === 0) continue
            window.electronAPI.scopePopout.publishChunk({
              scope: 'waveform',
              capturedAt: Date.now(),
              sampleRate: audioEngine.getSampleRate(),
              monoChunks,
              waveformScrollSpeed,
              waveformGainDb,
              waveformMultiband,
              lineColor,
              reset: false,
            })
            resetSentRef.current[scope] = false
            break
          }
        }
      }
    }, STREAM_INTERVAL_MS)

    return () => {
      if (streamTimerRef.current !== null) {
        window.clearInterval(streamTimerRef.current)
        streamTimerRef.current = null
      }
    }
  }, [
    scopePopoutState,
    nativeVisualizersAvailable,
    playbackState,
    isVisualizerRunning,
    lineColor,
    fftSize,
    spectrumDisplayMode,
    spectrumTiltDbPerOctave,
    spectrumHeatmap,
    spectrumHeatmapTiltDbPerOctave,
    spectrumSmoothing,
    spectrumHeatmapSmoothing,
    spectrumBarDensity,
    spectrumBarGapPercent,
    spectrumBarCornerRadiusPx,
    spectrumShowBarPeaks,
    spectrumHeatPalette,
    spectrumHeatColors,
    spectrogramFftSize,
    spectrogramScrollSpeed,
    spectrogramClarityMode,
    spectrogramScaleMode,
    spectrogramTiltDbPerOctave,
    spectrogramContrast,
    spectrogramOrientation,
    waveformScrollSpeed,
    waveformGainDb,
    waveformMultiband,
    pitchLock,
    oscilloscopeUnderfillEnabled,
    vectorscopeMode,
    vectorscopeMultiband,
    vuMeterMode,
    vuMeterOrientation,
    lufsMeterMode
  ])
}
