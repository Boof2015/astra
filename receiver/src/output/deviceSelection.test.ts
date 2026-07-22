import assert from 'node:assert/strict'
import test from 'node:test'
import type { AlsaDeviceOption } from './alsaDevices.ts'
import { createOutputDeviceSetter } from './deviceSelection.ts'

test('output selection persists and restarts only after a device becomes available', () => {
  let configuredDevice = 'plughw:Missing,0'
  let available: AlsaDeviceOption[] = []
  const persisted: string[] = []
  const restarts: string[] = []
  const logs: string[] = []
  const setOutputDevice = createOutputDeviceSetter({
    getConfiguredDevice: () => configuredDevice,
    listDevices: () => available,
    persistDevice: (device) => {
      configuredDevice = device
      persisted.push(device)
    },
    scheduleRestart: () => restarts.push('scheduled'),
    log: (message) => logs.push(message)
  })

  assert.equal(setOutputDevice('plughw:USB,0'), false)
  assert.equal(configuredDevice, 'plughw:Missing,0')
  assert.deepEqual(persisted, [])
  assert.deepEqual(restarts, [])

  available = [{ id: 'plughw:USB,0', label: 'USB DAC' }]
  assert.equal(setOutputDevice('plughw:USB,0'), true)
  assert.equal(configuredDevice, 'plughw:USB,0')
  assert.deepEqual(persisted, ['plughw:USB,0'])
  assert.deepEqual(restarts, ['scheduled'])
  assert.equal(logs.length, 1)

  assert.equal(setOutputDevice('plughw:USB,0'), true)
  assert.deepEqual(persisted, ['plughw:USB,0'])
  assert.deepEqual(restarts, ['scheduled'])
})

test('output selection retries the configured device when a fallback or failed null is active', () => {
  const persisted: string[] = []
  let restarts = 0
  const setOutputDevice = createOutputDeviceSetter({
    getConfiguredDevice: () => 'plughw:Headphones,0',
    listDevices: () => [{ id: 'plughw:Headphones,0', label: 'Headphones' }],
    persistDevice: (device) => persisted.push(device),
    shouldRestartCurrentDevice: () => true,
    scheduleRestart: () => { restarts += 1 },
    log: () => undefined
  })

  assert.equal(setOutputDevice('plughw:Headphones,0'), true)
  assert.deepEqual(persisted, [], 'unchanged user intent must not be rewritten')
  assert.equal(restarts, 1)
})

test('system default remains an accepted recovery choice', () => {
  let configuredDevice = 'plughw:Missing,0'
  let restarts = 0
  const setOutputDevice = createOutputDeviceSetter({
    getConfiguredDevice: () => configuredDevice,
    listDevices: () => [],
    persistDevice: (device) => { configuredDevice = device },
    scheduleRestart: () => { restarts += 1 },
    log: () => undefined
  })

  assert.equal(setOutputDevice('default'), true)
  assert.equal(configuredDevice, 'default')
  assert.equal(restarts, 1)
})
