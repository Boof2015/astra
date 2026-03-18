import { useEffect, useRef } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { usePlayerStore } from '../stores/playerStore'
import { useScopePopoutStore } from '../stores/scopePopoutStore'
import { useVisualizerSettingsStore } from '../stores/visualizerSettingsStore'
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
  const waveformScrollSpeed = useVisualizerSettingsStore((s) => s.waveformScrollSpeed)
  const pitchLock = useVisualizerSettingsStore((s) => s.pitchLock)
  const oscilloscopeUnderfillEnabled = useVisualizerSettingsStore((s) => s.oscilloscopeUnderfillEnabled)
  const vectorscopeMode = useVisualizerSettingsStore((s) => s.vectorscopeMode)
  const vectorscopeMultiband = useVisualizerSettingsStore((s) => s.vectorscopeMultiband)
  const vuMeterMode = useVisualizerSettingsStore((s) => s.vuMeterMode)
  const lufsMeterMode = useVisualizerSettingsStore((s) => s.lufsMeterMode)
  const isVisualizerRunning = useVisualizerSettingsStore((s) => s.isRunning)
  const scopePopoutState = useScopePopoutStore((s) => s.state)
  const setScopePopoutState = useScopePopoutStore((s) => s.setState)

  const streamTimerRef = useRef<number | null>(null)
  const resetSentRef = useRef<ResetState>({ ...EMPTY_RESET_STATE })

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
      spectrum: isVisualizerRunning && scopePopoutState.spectrum,
      oscilloscope: isVisualizerRunning && scopePopoutState.oscilloscope,
      vectorscope: isVisualizerRunning && scopePopoutState.vectorscope,
      spectrogram: isVisualizerRunning && scopePopoutState.spectrogram,
      vumeter: isVisualizerRunning && scopePopoutState.vumeter,
      lufsmeter: isVisualizerRunning && scopePopoutState.lufsmeter,
      waveform: isVisualizerRunning && scopePopoutState.waveform,
    })

    return () => {
      audioEngine.clearVisualizerConsumerDemand('scope-popout-bridge')
    }
  }, [isVisualizerRunning, scopePopoutState])

  useEffect(() => {
    if (streamTimerRef.current !== null) {
      window.clearInterval(streamTimerRef.current)
      streamTimerRef.current = null
    }

    for (const scope of SCOPE_KINDS) {
      if (!scopePopoutState[scope]) {
        resetSentRef.current[scope] = false
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
            lineColor,
            reset: true,
          })
          break
        case 'vumeter':
          window.electronAPI.scopePopout.publishChunk({
            scope: 'vumeter',
            capturedAt: Date.now(),
            sampleRate: audioEngine.getSampleRate(),
            stereoChunks: [],
            vuMeterMode,
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
            lineColor,
            reset: true,
          })
          break
      }
      resetSentRef.current[scope] = true
    }

    streamTimerRef.current = window.setInterval(() => {
      const shouldStream = playbackState === 'playing' && isVisualizerRunning

      for (const scope of poppedScopes) {
        if (!shouldStream) {
          flushScopeQueue(scope)
          if (!resetSentRef.current[scope]) {
            emitReset(scope)
          }
          continue
        }

        switch (scope) {
          case 'spectrum': {
            const monoChunks = audioEngine.flushPendingSpectrumSamples()
            if (monoChunks.length === 0) continue
            window.electronAPI.scopePopout.publishChunk({
              scope: 'spectrum',
              capturedAt: Date.now(),
              sampleRate: audioEngine.getSampleRate(),
              monoChunks,
              fftSize,
              lineColor,
              reset: false,
            })
            resetSentRef.current[scope] = false
            break
          }
          case 'oscilloscope': {
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
              lineColor,
              reset: false,
            })
            resetSentRef.current[scope] = false
            break
          }
          case 'vumeter': {
            const stereoChunks = audioEngine.flushPendingVUMeterSamples()
            if (stereoChunks.length === 0) continue
            window.electronAPI.scopePopout.publishChunk({
              scope: 'vumeter',
              capturedAt: Date.now(),
              sampleRate: audioEngine.getSampleRate(),
              stereoChunks,
              vuMeterMode,
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
    playbackState,
    isVisualizerRunning,
    lineColor,
    fftSize,
    spectrogramFftSize,
    spectrogramScrollSpeed,
    spectrogramClarityMode,
    spectrogramScaleMode,
    waveformScrollSpeed,
    pitchLock,
    oscilloscopeUnderfillEnabled,
    vectorscopeMode,
    vectorscopeMultiband,
    vuMeterMode,
    lufsMeterMode
  ])
}
