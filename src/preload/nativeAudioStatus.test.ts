import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeNativeAudioOutputStatus } from './nativeAudioController.ts'
import {
  createNativeOutputFailureError,
  parseNativeOutputFailureError,
  stripNativeOutputFailureTag
} from '../shared/audio/bitPerfectFormatError.ts'

const verifiedBase = {
  streamRunning: true,
  exclusiveAcquired: true,
  systemMixerBypassed: true,
  sourceSamplesModified: false,
  wireFormatCanCarrySourceExactly: true
}

test('derives bit-perfect activation solely from the verified runtime rule', () => {
  const active = normalizeNativeAudioOutputStatus({
    ...verifiedBase,
    bitPerfectActive: false
  })
  assert.equal(active.bitPerfectActive, true)

  for (const override of [
    { streamRunning: false },
    { exclusiveAcquired: false },
    { systemMixerBypassed: false },
    { sourceSamplesModified: true },
    { wireFormatCanCarrySourceExactly: false }
  ]) {
    const inactive = normalizeNativeAudioOutputStatus({
      ...verifiedBase,
      ...override,
      bitPerfectActive: true
    })
    assert.equal(inactive.bitPerfectActive, false)
  }
})

test('does not report activation while output is merely open, negotiated, or initialized', () => {
  const status = normalizeNativeAudioOutputStatus({
    outputOpen: true,
    deviceResolved: true,
    formatNegotiated: true,
    streamInitialized: true,
    streamStarted: false,
    streamRunning: false,
    exclusiveAcquired: true,
    systemMixerBypassed: true,
    wireFormatCanCarrySourceExactly: true,
    bitPerfectActive: true
  })
  assert.equal(status.exclusiveAcquired, true)
  assert.equal(status.bitPerfectActive, false)
})

test('normalizes complete PCM and attempt diagnostics', () => {
  const status = normalizeNativeAudioOutputStatus({
    ...verifiedBase,
    backend: 'wasapi-exclusive',
    transport: 'timer-driven',
    actualPeriodMs: 10,
    wireFormat: {
      sampleRate: 192000,
      channels: 2,
      sampleFormat: 's24in32',
      containerBits: 32,
      validBits: 24,
      channelMask: 3,
      channelLayout: 'stereo',
      representation: 'WAVEFORMATEXTENSIBLE/interleaved'
    },
    attempts: [{
      index: 2,
      backend: 'wasapi-exclusive',
      probeResult: 'rejected',
      streamInitialized: true,
      bufferPrimed: true,
      streamStarted: true,
      finalVerified: true
    }]
  })
  assert.equal(status.wireFormat.sampleFormat, 's24in32')
  assert.equal(status.wireFormat.validBits, 24)
  assert.equal(status.attempts[0].probeResult, 'rejected')
  assert.equal(status.attempts[0].finalVerified, true)
})

test('native output failures retain stage, OS code, and report across an Error message bridge', () => {
  const error = createNativeOutputFailureError({
    deviceLabel: 'Test DAC',
    sampleRate: 96000,
    channels: 2,
    sampleFormat: 's24',
    message: 'The platform start call failed.',
    failureStage: 'start',
    osCode: 'AUDCLNT_E_DEVICE_IN_USE',
    report: 'attempt #1\nattempt #2'
  })
  const parsed = parseNativeOutputFailureError(error)
  assert.equal(parsed?.failureStage, 'start')
  assert.equal(parsed?.osCode, 'AUDCLNT_E_DEVICE_IN_USE')
  assert.equal(parsed?.report, 'attempt #1\nattempt #2')
  assert.equal(stripNativeOutputFailureTag(error.message), 'The platform start call failed.')
})
