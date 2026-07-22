import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReceiverConfig } from '../config.ts'
import { createOutputBackend } from './backendFactory.ts'
import { NullOutput } from './nullOutput.ts'
import type { OutputBackend } from './types.ts'

function receiverConfig(overrides: Partial<ReceiverConfig> = {}): ReceiverConfig {
  return {
    endpointUuid: 'uuid',
    sinkName: 'test receiver',
    audioDevice: 'plughw:Configured,0',
    audioBackend: 'alsa',
    volumePercent: 100,
    listenerPort: 38404,
    webPort: 38405,
    cecControl: false,
    cecWakeOn: 'play',
    cecSwitchInput: true,
    cecStandbyMinutes: 10,
    clockFormat: 'auto',
    apSetup: false,
    connection: null,
    ...overrides
  }
}

function fakeBackend(device: string): OutputBackend {
  return {
    deviceId: device,
    deviceLabel: `ALSA ${device}`,
    sampleRate: 48_000,
    channels: 2,
    write: (_samples, frames) => frames,
    framesWritten: () => 0,
    bufferedFrames: () => 0,
    underruns: () => 0,
    close: () => undefined
  }
}

test('backend factory opens the configured ALSA output without trying fallbacks', () => {
  const attempts: string[] = []
  const result = createOutputBackend(receiverConfig(), {
    createAlsaOutput: (device) => {
      attempts.push(device)
      return fakeBackend(device)
    },
    log: () => undefined
  })

  assert.equal(result.audioAvailable, true)
  assert.equal(result.audioError, null)
  assert.equal(result.backend.deviceId, 'plughw:Configured,0')
  assert.deepEqual(attempts, ['plughw:Configured,0'])
})

test('backend factory reports fallback success without changing the configured device', () => {
  const config = receiverConfig()
  const before = structuredClone(config)
  const attempts: string[] = []
  const logs: string[] = []
  const result = createOutputBackend(config, {
    createAlsaOutput: (device) => {
      attempts.push(device)
      if (device !== 'plughw:1,0') throw new Error('snd_pcm_open failed: No such device')
      return fakeBackend(device)
    },
    log: (message) => logs.push(message)
  })

  assert.equal(result.audioAvailable, true)
  assert.equal(result.audioError, null)
  assert.equal(result.backend.deviceId, 'plughw:1,0')
  assert.deepEqual(attempts, ['plughw:Configured,0', 'default', 'plughw:0,0', 'plughw:1,0'])
  assert.deepEqual(config, before)
  assert.equal(logs.some((message) => message.includes('using fallback "plughw:1,0"')), true)
})

test('intentional null output is nonfatal and does not report an ALSA failure', () => {
  let attempted = false
  const result = createOutputBackend(receiverConfig({ audioBackend: 'null' }), {
    createAlsaOutput: () => {
      attempted = true
      throw new Error('must not be called')
    }
  })

  assert.equal(result.backend instanceof NullOutput, true)
  assert.equal(result.audioAvailable, false)
  assert.equal(result.audioError, null)
  assert.equal(attempted, false)
})

test('backend factory deduplicates the configured device from ALSA fallbacks', () => {
  const attempts: string[] = []
  const result = createOutputBackend(receiverConfig({ audioDevice: 'default' }), {
    createAlsaOutput: (device) => {
      attempts.push(device)
      throw new Error('unavailable')
    },
    log: () => undefined
  })

  assert.equal(result.audioAvailable, false)
  assert.deepEqual(attempts, ['default', 'plughw:0,0', 'plughw:1,0', 'plughw:2,0'])
})

test('total ALSA failure returns null output with sanitized status and one-line logs', () => {
  const config = receiverConfig({ audioDevice: 'plughw:Missing,0' })
  const before = structuredClone(config)
  const attempts: string[] = []
  const logs: string[] = []
  const result = createOutputBackend(config, {
    createAlsaOutput: (device) => {
      attempts.push(device)
      throw new Error('snd_pcm_open failed\nprocess detail that must stay on one line')
    },
    log: (message) => logs.push(message)
  })

  assert.equal(result.backend instanceof NullOutput, true)
  assert.equal(result.backend.deviceLabel, 'Null output (no audio)')
  assert.equal(result.audioAvailable, false)
  assert.match(result.audioError ?? '', /Choose a detected output/)
  assert.doesNotMatch(result.audioError ?? '', /snd_pcm|process detail/)
  assert.deepEqual(config, before)
  assert.equal(logs.filter((message) => message.startsWith('trying ALSA output')).length, attempts.length)
  assert.equal(logs.filter((message) => message.includes(' failed: ')).length, attempts.length)
  assert.equal(logs.at(-1), 'no ALSA output candidate opened — continuing with Null output (no audio)')
  assert.equal(logs.every((message) => !/[\r\n]/.test(message)), true)
})
