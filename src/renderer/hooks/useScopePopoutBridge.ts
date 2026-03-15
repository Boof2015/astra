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
  }
}

export function useScopePopoutBridge(): void {
  const playbackState = usePlayerStore((s) => s.playbackState)
  const lineColor = useVisualizerSettingsStore((s) => s.lineColor)
  const fftSize = useVisualizerSettingsStore((s) => s.fftSize)
  const pitchLock = useVisualizerSettingsStore((s) => s.pitchLock)
  const oscilloscopeUnderfillEnabled = useVisualizerSettingsStore((s) => s.oscilloscopeUnderfillEnabled)
  const vectorscopeMode = useVisualizerSettingsStore((s) => s.vectorscopeMode)
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
    pitchLock,
    oscilloscopeUnderfillEnabled,
    vectorscopeMode
  ])
}
