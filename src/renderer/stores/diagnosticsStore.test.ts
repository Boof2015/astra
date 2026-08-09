import test from 'node:test'
import assert from 'node:assert/strict'
import type { LocalPcmOutputSink, MemoryDiagnosticsStatus } from '../../types/diagnostics.ts'
import { resolveLocalPcmOutputSink, useDiagnosticsStore } from './diagnosticsStore.ts'

function makeStatus(
  enabled: boolean,
  localPcmTempFileSinkEnabled = false,
  localPcmOutputSink: LocalPcmOutputSink = localPcmTempFileSinkEnabled
    ? 'temporary_file'
    : 'stdout_pipe',
): MemoryDiagnosticsStatus {
  return {
    enabled,
    localPcmOutputSink,
    localPcmTempFileSinkEnabled,
    sampleIntervalMs: 15_000,
    currentLogPath: '/logs/current.csv',
    previousLogPath: '/logs/previous.csv',
    hasCurrentLog: false,
    hasPreviousLog: false,
    sessionStartedAt: enabled ? 1 : null,
  }
}

function installOutputSinkSetter(
  setter: (sink: LocalPcmOutputSink) => Promise<MemoryDiagnosticsStatus>,
): void {
  const globalWithWindow = globalThis as unknown as {
    window: {
      electronAPI: {
        diagnostics: {
          setLocalPcmOutputSink: typeof setter
        }
      }
    }
  }
  globalWithWindow.window = {
    electronAPI: {
      diagnostics: {
        setLocalPcmOutputSink: setter,
      },
    },
  }
}

function resetDiagnosticsStore(status: MemoryDiagnosticsStatus): void {
  useDiagnosticsStore.setState({
    status,
    isLoading: false,
    isInitialized: true,
    isCapturingBundle: false,
    isRunningPcmTransferBenchmark: false,
    pcmTransferBenchmarkProgress: null,
    lastCaptureResult: null,
    lastPcmTransferBenchmark: null,
    errorMessage: '',
  })
}

function installSinkSetter(
  setter: (enabled: boolean) => Promise<MemoryDiagnosticsStatus>,
): void {
  const globalWithWindow = globalThis as unknown as {
    window: {
      electronAPI: {
        diagnostics: {
          setLocalPcmTempFileSinkEnabled: typeof setter
        }
      }
    }
  }
  globalWithWindow.window = {
    electronAPI: {
      diagnostics: {
        setLocalPcmTempFileSinkEnabled: setter,
      },
    },
  }
}

test('temporary PCM sink applies the authoritative diagnostics status returned by main', async () => {
  const calls: boolean[] = []
  installSinkSetter(async (enabled) => {
    calls.push(enabled)
    return makeStatus(true, enabled)
  })
  resetDiagnosticsStore(makeStatus(true))

  const result = await useDiagnosticsStore.getState().setLocalPcmTempFileSinkEnabled(true)

  assert.deepEqual(calls, [true])
  assert.equal(result?.localPcmTempFileSinkEnabled, true)
  assert.equal(useDiagnosticsStore.getState().status?.localPcmTempFileSinkEnabled, true)
  assert.equal(useDiagnosticsStore.getState().errorMessage, '')
})

test('temporary PCM sink cannot be enabled while diagnostics logging is disabled', async () => {
  let callCount = 0
  installSinkSetter(async () => {
    callCount += 1
    return makeStatus(false)
  })
  resetDiagnosticsStore(makeStatus(false))

  const result = await useDiagnosticsStore.getState().setLocalPcmTempFileSinkEnabled(true)

  assert.equal(result, null)
  assert.equal(callCount, 0)
  assert.match(useDiagnosticsStore.getState().errorMessage, /Enable diagnostics logging/)
})

test('temporary PCM sink cannot change during the PCM transfer benchmark', async () => {
  let callCount = 0
  installSinkSetter(async () => {
    callCount += 1
    return makeStatus(true, true)
  })
  resetDiagnosticsStore(makeStatus(true))
  useDiagnosticsStore.setState({ isRunningPcmTransferBenchmark: true })

  const result = await useDiagnosticsStore.getState().setLocalPcmTempFileSinkEnabled(true)

  assert.equal(result, null)
  assert.equal(callCount, 0)
  assert.match(useDiagnosticsStore.getState().errorMessage, /benchmark to finish/)
})

test('temporary PCM sink bridge failures preserve the last authoritative status', async () => {
  installSinkSetter(async () => {
    throw new Error('Sink update failed.')
  })
  const initialStatus = makeStatus(true)
  resetDiagnosticsStore(initialStatus)

  const result = await useDiagnosticsStore.getState().setLocalPcmTempFileSinkEnabled(true)

  assert.equal(result, null)
  assert.equal(useDiagnosticsStore.getState().status, initialStatus)
  assert.equal(useDiagnosticsStore.getState().errorMessage, 'Sink update failed.')
})

test('PCM output route applies the authoritative diagnostics status returned by main', async () => {
  const calls: LocalPcmOutputSink[] = []
  installOutputSinkSetter(async (sink) => {
    calls.push(sink)
    return makeStatus(true, false, sink)
  })
  resetDiagnosticsStore(makeStatus(true))

  const result = await useDiagnosticsStore.getState().setLocalPcmOutputSink('worker_thread')

  assert.deepEqual(calls, ['worker_thread'])
  assert.equal(result?.localPcmOutputSink, 'worker_thread')
  assert.equal(useDiagnosticsStore.getState().status?.localPcmOutputSink, 'worker_thread')
  assert.equal(useDiagnosticsStore.getState().errorMessage, '')
})

test('experimental PCM output routes require diagnostics logging', async () => {
  let callCount = 0
  installOutputSinkSetter(async () => {
    callCount += 1
    return makeStatus(false)
  })
  resetDiagnosticsStore(makeStatus(false))

  const result = await useDiagnosticsStore.getState().setLocalPcmOutputSink('worker_thread')

  assert.equal(result, null)
  assert.equal(callCount, 0)
  assert.match(useDiagnosticsStore.getState().errorMessage, /Enable diagnostics logging/)
})

test('PCM output route can reset to pipe while diagnostics logging is disabled', async () => {
  const calls: LocalPcmOutputSink[] = []
  installOutputSinkSetter(async (sink) => {
    calls.push(sink)
    return makeStatus(false, false, sink)
  })
  resetDiagnosticsStore(makeStatus(false, false, 'worker_thread'))

  const result = await useDiagnosticsStore.getState().setLocalPcmOutputSink('stdout_pipe')

  assert.deepEqual(calls, ['stdout_pipe'])
  assert.equal(result?.localPcmOutputSink, 'stdout_pipe')
})

test('PCM output route cannot change during the transfer benchmark', async () => {
  let callCount = 0
  installOutputSinkSetter(async () => {
    callCount += 1
    return makeStatus(true)
  })
  resetDiagnosticsStore(makeStatus(true))
  useDiagnosticsStore.setState({ isRunningPcmTransferBenchmark: true })

  const result = await useDiagnosticsStore.getState().setLocalPcmOutputSink('worker_thread')

  assert.equal(result, null)
  assert.equal(callCount, 0)
  assert.match(useDiagnosticsStore.getState().errorMessage, /benchmark to finish/)
})

test('PCM output route bridge failures preserve the last authoritative status', async () => {
  installOutputSinkSetter(async () => {
    throw new Error('Route update failed.')
  })
  const initialStatus = makeStatus(true)
  resetDiagnosticsStore(initialStatus)

  const result = await useDiagnosticsStore.getState().setLocalPcmOutputSink('worker_thread')

  assert.equal(result, null)
  assert.equal(useDiagnosticsStore.getState().status, initialStatus)
  assert.equal(useDiagnosticsStore.getState().errorMessage, 'Route update failed.')
})

test('PCM output route resolves statuses from older temporary-file builds', () => {
  const legacyStatus = makeStatus(true, true)
  delete legacyStatus.localPcmOutputSink

  assert.equal(resolveLocalPcmOutputSink(makeStatus(true, false, 'rechunked_pipe')), 'rechunked_pipe')
  assert.equal(resolveLocalPcmOutputSink(makeStatus(true, false, 'native_pipe')), 'native_pipe')
  assert.equal(resolveLocalPcmOutputSink(legacyStatus), 'temporary_file')
  assert.equal(resolveLocalPcmOutputSink(null), 'stdout_pipe')
})
