import { create } from 'zustand'
import type {
  LocalPcmOutputSink,
  MemoryDiagnosticsCaptureBundleResult,
  MemoryDiagnosticsStatus
} from '../../types/diagnostics'
import {
  createMainPortPcmTransferBenchmarkProbe,
  runPcmTransferBenchmark,
  type PcmTransferBenchmarkProgress,
  type PcmTransferBenchmarkSummary
} from '../utils/pcmTransferBenchmark'
import { createLocalPcmStreamClient, type LocalPcmStreamClient } from '../audio/localPcmStreamClient'

interface DiagnosticsStore {
  status: MemoryDiagnosticsStatus | null
  isLoading: boolean
  isInitialized: boolean
  isCapturingBundle: boolean
  isRunningPcmTransferBenchmark: boolean
  pcmTransferBenchmarkProgress: PcmTransferBenchmarkProgress | null
  lastCaptureResult: MemoryDiagnosticsCaptureBundleResult | null
  lastPcmTransferBenchmark: PcmTransferBenchmarkSummary | null
  errorMessage: string
  init: () => Promise<void>
  refresh: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<MemoryDiagnosticsStatus | null>
  setLocalPcmOutputSink: (sink: LocalPcmOutputSink) => Promise<MemoryDiagnosticsStatus | null>
  setLocalPcmTempFileSinkEnabled: (enabled: boolean) => Promise<MemoryDiagnosticsStatus | null>
  captureBundle: (tag?: string) => Promise<MemoryDiagnosticsCaptureBundleResult | null>
  runPcmTransferBenchmark: () => Promise<PcmTransferBenchmarkSummary | null>
  revealCurrentLog: () => Promise<boolean>
  revealPreviousLog: () => Promise<boolean>
}

let statusUnsubscribe: (() => void) | null = null

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Failed to update memory diagnostics.'
}

export function resolveLocalPcmOutputSink(
  status: MemoryDiagnosticsStatus | null | undefined
): LocalPcmOutputSink {
  if (
    status?.localPcmOutputSink === 'stdout_pipe'
    || status?.localPcmOutputSink === 'rechunked_pipe'
    || status?.localPcmOutputSink === 'native_pipe'
    || status?.localPcmOutputSink === 'preload_native'
    || status?.localPcmOutputSink === 'worker_thread'
    || status?.localPcmOutputSink === 'temporary_file'
  ) {
    return status.localPcmOutputSink
  }
  return status?.localPcmTempFileSinkEnabled ? 'temporary_file' : 'stdout_pipe'
}

export const useDiagnosticsStore = create<DiagnosticsStore>((set, get) => {
  const applyStatus = (status: MemoryDiagnosticsStatus): MemoryDiagnosticsStatus => {
    set({
      status,
      errorMessage: ''
    })
    return status
  }

  const ensureSubscription = () => {
    if (statusUnsubscribe) return
    statusUnsubscribe = window.electronAPI.diagnostics.onStatus((status) => {
      applyStatus(status)
    })
  }

  const fetchStatus = async (): Promise<MemoryDiagnosticsStatus> => {
    const status = await window.electronAPI.diagnostics.getStatus()
    ensureSubscription()
    return applyStatus(status)
  }

  return {
    status: null,
    isLoading: false,
    isInitialized: false,
    isCapturingBundle: false,
    isRunningPcmTransferBenchmark: false,
    pcmTransferBenchmarkProgress: null,
    lastCaptureResult: null,
    lastPcmTransferBenchmark: null,
    errorMessage: '',

    init: async () => {
      if (get().isInitialized) return
      set({ isLoading: true })
      try {
        await fetchStatus()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      } finally {
        set({ isLoading: false, isInitialized: true })
      }
    },

    refresh: async () => {
      set({ isLoading: true })
      try {
        await fetchStatus()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
      } finally {
        set({ isLoading: false })
      }
    },

    setEnabled: async (enabled: boolean) => {
      if (get().isRunningPcmTransferBenchmark) {
        set({ errorMessage: 'Wait for the PCM transfer benchmark to finish before changing diagnostics logging.' })
        return null
      }
      try {
        const status = await window.electronAPI.diagnostics.setEnabled(enabled)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    setLocalPcmOutputSink: async (sink: LocalPcmOutputSink) => {
      if (get().isRunningPcmTransferBenchmark) {
        set({ errorMessage: 'Wait for the PCM transfer benchmark to finish before changing the PCM route.' })
        return null
      }
      if (sink !== 'stdout_pipe' && get().status?.enabled !== true) {
        set({ errorMessage: 'Enable diagnostics logging before using an experimental PCM route.' })
        return null
      }
      try {
        const status = await window.electronAPI.diagnostics.setLocalPcmOutputSink(sink)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    setLocalPcmTempFileSinkEnabled: async (enabled: boolean) => {
      if (get().isRunningPcmTransferBenchmark) {
        set({ errorMessage: 'Wait for the PCM transfer benchmark to finish before changing the PCM sink.' })
        return null
      }
      if (enabled && get().status?.enabled !== true) {
        set({ errorMessage: 'Enable diagnostics logging before using the temporary PCM sink.' })
        return null
      }
      try {
        const status = await window.electronAPI.diagnostics.setLocalPcmTempFileSinkEnabled(enabled)
        return applyStatus(status)
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      }
    },

    captureBundle: async (tag?: string) => {
      if (get().isCapturingBundle) return null
      if (get().isRunningPcmTransferBenchmark) {
        set({ errorMessage: 'Wait for the PCM transfer benchmark to finish before capturing a memory bundle.' })
        return null
      }
      set({ isCapturingBundle: true, errorMessage: '' })
      try {
        const result = await window.electronAPI.diagnostics.captureMemoryBundle(tag)
        set({
          isCapturingBundle: false,
          lastCaptureResult: result
        })
        return result
      } catch (error) {
        set({
          isCapturingBundle: false,
          errorMessage: toErrorMessage(error)
        })
        return null
      }
    },

    runPcmTransferBenchmark: async () => {
      if (get().isRunningPcmTransferBenchmark) return null
      if (get().isCapturingBundle) {
        set({ errorMessage: 'Wait for the memory bundle capture to finish before running the PCM transfer benchmark.' })
        return null
      }
      if (get().status?.enabled !== true) {
        set({ errorMessage: 'Enable diagnostics logging before running the PCM transfer benchmark.' })
        return null
      }

      set({
        isRunningPcmTransferBenchmark: true,
        pcmTransferBenchmarkProgress: null,
        errorMessage: ''
      })
      let portBenchmarkClient: LocalPcmStreamClient | null = null
      try {
        const diagnostics = window.electronAPI.diagnostics
        portBenchmarkClient = createLocalPcmStreamClient({
          windowTarget: {
            sourceIdentity: window,
            addMessageListener: (listener) => window.addEventListener('message', listener),
            removeMessageListener: (listener) => window.removeEventListener('message', listener)
          },
          openLocalAudioPcmStream: (
            requestId,
            filePath,
            outputSampleRate,
            expectedChannels,
            priority,
            nonce
          ) => {
            const prefix = 'pcm-transfer-benchmark:'
            if (
              !filePath.startsWith(prefix)
              || outputSampleRate !== 48_000
              || expectedChannels !== 1
              || priority !== 'interactive'
            ) {
              return false
            }
            const sizeBytes = Number(filePath.slice(prefix.length))
            return diagnostics.openMainPcmStreamBenchmark(requestId, sizeBytes, nonce)
          }
        })
        const benchmarkMainPortPcmTransfer = createMainPortPcmTransferBenchmarkProbe(portBenchmarkClient)
        const summary = await runPcmTransferBenchmark({
          benchmarkMainPcmTransfer: (sizeBytes) => diagnostics.benchmarkMainPcmTransfer(sizeBytes),
          benchmarkPreloadPcmTransfer: (sizeBytes) => diagnostics.benchmarkPreloadPcmTransfer(sizeBytes),
          benchmarkMainPortPcmTransfer,
          logEvent: (payload, options) => diagnostics.logEvent(payload, options)
        }, {
          onProgress: (progress) => set({ pcmTransferBenchmarkProgress: progress })
        })
        set({
          lastPcmTransferBenchmark: summary,
          errorMessage: ''
        })
        return summary
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return null
      } finally {
        portBenchmarkClient?.dispose()
        set({
          isRunningPcmTransferBenchmark: false,
          pcmTransferBenchmarkProgress: null
        })
      }
    },

    revealCurrentLog: async () => {
      try {
        return await window.electronAPI.diagnostics.revealCurrentLog()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return false
      }
    },

    revealPreviousLog: async () => {
      try {
        return await window.electronAPI.diagnostics.revealPreviousLog()
      } catch (error) {
        set({ errorMessage: toErrorMessage(error) })
        return false
      }
    }
  }
})
