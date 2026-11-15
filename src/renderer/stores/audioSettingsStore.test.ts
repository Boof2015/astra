import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { audioEngine } from '../audio/AudioEngine.ts'
import { builtinHrtfProfile } from '../../types/hrtfProfiles.ts'
import type { DeviceSpeakerProfile } from '../utils/speakerLayout.ts'
import type { NativeAudioCapabilities, PlaybackOutputMode } from '../../types/nativeAudio.ts'
import { resolveOutputDeviceLabel, useAudioSettingsStore } from './audioSettingsStore.ts'

const OUTPUT_KEY = 'astra-audio-output-device'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function outputs(defaultId: string, ids = ['a', 'b', 'c']): MediaDeviceInfo[] {
  return [
    { deviceId: 'default', label: `Default - ${defaultId}`, groupId: defaultId },
    ...ids.map((id) => ({ deviceId: id, label: id.toUpperCase(), groupId: id })),
  ].map((device) => ({ ...device, kind: 'audiooutput', toJSON: () => device }) as MediaDeviceInfo)
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function setup(t: TestContext) {
  useAudioSettingsStore.getState().stopDeviceMonitoring()
  useAudioSettingsStore.setState(useAudioSettingsStore.getInitialState(), true)
  const storage = new Map<string, string>()
  const mediaDevices = Object.assign(new EventTarget(), { enumerateDevices: async () => state.devices })
  const windowEvents = Object.assign(new EventTarget(), {
    location: { search: '?window=test' },
    electronAPI: {
      getReplayGainScanEnabled: async () => false,
      setReplayGainScanEnabled: async () => undefined,
      hrtfProfiles: { list: async () => [builtinHrtfProfile()] },
    },
  })
  const globals = {
    navigator: { mediaDevices },
    window: windowEvents,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    },
  }
  const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })
  t.after(() => {
    useAudioSettingsStore.getState().stopDeviceMonitoring()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  const capabilities: NativeAudioCapabilities = {
    bitPerfectAvailable: true,
    processedExclusiveAvailable: true,
    reasonUnavailable: null,
    reasonProcessedExclusiveUnavailable: null,
    activeBackend: 'coreaudio',
    selectedDeviceId: 'native-a',
    selectedDeviceMaxChannels: 2,
    devices: [{ deviceId: 'native-a', label: 'Native A', isDefault: true, maxChannels: 2 }],
  }
  const state = {
    devices: outputs('a'),
    sinkId: '',
    mode: 'standard' as PlaybackOutputMode,
    switches: [] as string[],
    modeChanges: [] as PlaybackOutputMode[],
    profiles: [] as number[],
    delays: [] as number[],
    failures: 0,
    switchGate: null as Promise<void> | null,
  }
  const enumeration = t.mock.method(mediaDevices, 'enumerateDevices', async () => state.devices)
  t.mock.method(audioEngine, 'getOutputDeviceId', () => state.sinkId || 'default')
  t.mock.method(audioEngine, 'setOutputDevice', async (id: string) => {
    state.switches.push(id)
    if (state.switchGate) await state.switchGate
    if (state.failures > 0) { state.failures -= 1; throw new Error('Device temporarily unavailable') }
    state.sinkId = id
  })
  t.mock.method(audioEngine, 'getOutputMaxChannelCount', () => state.sinkId === 'b' ? 6 : 2)
  t.mock.method(audioEngine, 'ensureContextReady', async () => undefined)
  t.mock.method(audioEngine, 'setSpeakerOutputConfiguration', async (_profile: DeviceSpeakerProfile, count: number) => { state.profiles.push(count) })
  t.mock.method(audioEngine, 'setAnalysisDelayMs', async (ms: number) => { state.delays.push(ms) })
  t.mock.method(audioEngine, 'setPlaybackOutputMode', async (mode: PlaybackOutputMode) => {
    state.modeChanges.push(mode)
    state.mode = mode
    return { activeMode: mode, capabilities, message: null }
  })
  t.mock.method(audioEngine, 'refreshNativeAudioCapabilities', async () => capabilities)
  t.mock.method(audioEngine, 'getNativeAudioCapabilities', () => capabilities)
  t.mock.method(audioEngine, 'getNativeAudioOutputStatus', () => null)
  t.mock.method(audioEngine, 'getPlaybackModeStatusMessage', () => null)
  for (const method of ['setExclusiveSampleRate', 'setExclusiveLimiterEnabled', 'setMultichannelEnabled',
    'setIncludeLfeInDownmix', 'setStereoUpmixMode', 'setHrtfProfile', 'setVirtualSpeakers',
    'setSourceSpeakerRoutingMap', 'setSpatialMode'] as const) {
    t.mock.method(audioEngine, method, async () => undefined)
  }
  t.mock.method(audioEngine, 'setReplayGainEnabled', () => undefined)
  t.mock.method(console, 'warn', () => undefined)
  return { state, storage, mediaDevices, windowEvents, enumeration, store: useAudioSettingsStore.getState }
}

test('System Default follows physical endpoints without persisting them or rebuilding unchanged routes', async (t) => {
  const h = setup(t)
  await h.store().selectDevice('default')
  assert.equal(h.store().selectedDeviceId, '')
  assert.equal(h.storage.has(OUTPUT_KEY), false)
  assert.deepEqual(h.state.switches, ['a'])
  assert.equal(h.store().availableDevices[0].deviceId, '')
  await h.store().refreshDevices()
  assert.deepEqual(h.state.switches, ['a'])
  assert.deepEqual(h.state.profiles, [2])
  assert.deepEqual(h.state.delays, [0])
  h.state.devices = outputs('b')
  await h.store().refreshDevices()
  assert.deepEqual(h.state.switches, ['a', 'b'])
  assert.equal(h.store().activeSpeakerProfileKey, 'b')
  assert.equal(h.store().activeDelayProfileKey, 'b')
  assert.equal(h.store().selectedDeviceMaxChannelCount, 6)
  assert.equal(resolveOutputDeviceLabel('', h.store().availableDevices).label, 'B (System Default)')
  assert.equal(h.storage.has(OUTPUT_KEY), false)
})

test('startup and restart preserve absent and legacy default selections, and explicit selections', async (t) => {
  const h = setup(t)
  for (const saved of [null, 'default', 'c']) {
    if (saved === null) h.storage.delete(OUTPUT_KEY)
    else h.storage.set(OUTPUT_KEY, saved)
    await h.store().initFromSaved()
    assert.equal(h.store().selectedDeviceId, saved === 'c' ? 'c' : '')
    assert.equal(h.state.sinkId, saved === 'c' ? 'c' : 'a')
    assert.equal(h.storage.get(OUTPUT_KEY), saved === 'c' ? 'c' : undefined)
  }
  h.storage.delete(OUTPUT_KEY)
  h.state.devices = outputs('b')
  await h.store().initFromSaved()
  assert.equal(h.state.sinkId, 'b')
  assert.equal(h.store().selectedDeviceId, '')
})

test('Windows communications alias is not mistaken for the physical default endpoint', async (t) => {
  const h = setup(t)
  h.state.devices.splice(1, 0, { ...h.state.devices[0], deviceId: 'communications' })
  await h.store().selectDevice('default')
  assert.deepEqual(h.state.switches, ['a'])
})

test('explicit selection stays pinned until its endpoint disappears', async (t) => {
  const h = setup(t)
  await h.store().selectDevice('c')
  h.state.devices = outputs('b')
  await h.store().refreshDevices()
  assert.deepEqual(h.state.switches, ['c'])
  assert.equal(h.storage.get(OUTPUT_KEY), 'c')
  h.state.devices = outputs('b', ['a', 'b'])
  await h.store().refreshDevices()
  assert.deepEqual(h.state.switches, ['c', 'b'])
  assert.equal(h.store().selectedDeviceId, '')
  assert.equal(h.storage.has(OUTPUT_KEY), false)
})

test('unresolved and absent outputs keep default intent and recover when a device returns', async (t) => {
  const h = setup(t)
  h.state.devices = outputs('a').slice(0, 1)
  await h.store().selectDevice('')
  assert.deepEqual(h.state.switches, [''])
  h.state.devices = []
  await h.store().refreshDevices()
  assert.equal(h.store().selectedDeviceId, '')
  h.state.devices = outputs('b')
  await h.store().refreshDevices()
  assert.deepEqual(h.state.switches, ['', 'b'])
})

test('failed switching retries once without marking a failed route applied, then recovers', async (t) => {
  const h = setup(t)
  await h.store().refreshDevices()
  h.state.devices = outputs('b')
  h.state.failures = 2
  await h.store().refreshDevices()
  assert.deepEqual(h.state.switches, ['a', 'b', 'b'])
  assert.equal(h.store().activeSpeakerProfileKey, 'a')
  assert.equal(h.store().selectedDeviceId, '')
  await h.store().refreshDevices()
  assert.equal(h.state.sinkId, 'b')
  assert.equal(h.store().activeSpeakerProfileKey, 'b')
})

test('failed enumeration does not discard a saved selection', async (t) => {
  const h = setup(t)
  await h.store().selectDevice('c')
  h.enumeration.mock.mockImplementation(async () => { throw new Error('Enumeration unavailable') })
  await h.store().refreshDevices()
  assert.equal(h.store().selectedDeviceId, 'c')
  assert.equal(h.storage.get(OUTPUT_KEY), 'c')
  assert.deepEqual(h.state.switches, ['c'])
})

test('a failed explicit device choice restores the previous selection and persistence', async (t) => {
  const h = setup(t)
  await h.store().selectDevice('c')
  h.state.failures = 2
  await h.store().selectDevice('b')
  assert.equal(h.store().selectedDeviceId, 'c')
  assert.equal(h.storage.get(OUTPUT_KEY), 'c')
  assert.equal(h.state.sinkId, 'c')
})

test('a manual selection supersedes an enumeration already in flight', async (t) => {
  const h = setup(t)
  const gate = deferred<MediaDeviceInfo[]>()
  h.enumeration.mock.mockImplementationOnce(() => gate.promise)
  const refreshing = h.store().refreshDevices()
  await flush()
  const selecting = h.store().selectDevice('c')
  gate.resolve(outputs('a'))
  await Promise.all([refreshing, selecting])
  assert.deepEqual(h.state.switches, ['c'])
  assert.equal(h.store().selectedDeviceId, 'c')
  assert.equal(h.storage.get(OUTPUT_KEY), 'c')
})

test('sink switches are serialized and newer notifications converge on the latest default', async (t) => {
  const h = setup(t)
  const gate = deferred<void>()
  h.state.switchGate = gate.promise
  const first = h.store().refreshDevices()
  await flush()
  h.state.devices = outputs('b')
  const second = h.store().refreshDevices()
  h.state.devices = outputs('c')
  const third = h.store().refreshDevices()
  assert.deepEqual(h.state.switches, ['a'])
  h.state.switchGate = null
  gate.resolve()
  await Promise.all([first, second, third])
  assert.deepEqual(h.state.switches, ['a', 'c'])
  assert.equal(h.store().activeSpeakerProfileKey, 'c')
})

test('a manual selection wins even when the previous default sink is already opening', async (t) => {
  const h = setup(t)
  const gate = deferred<void>()
  h.state.switchGate = gate.promise
  const refreshing = h.store().refreshDevices()
  await flush()
  const selecting = h.store().selectDevice('c')
  h.state.switchGate = null
  gate.resolve()
  await Promise.all([refreshing, selecting])
  assert.deepEqual(h.state.switches, ['a', 'c'])
  assert.equal(h.store().selectedDeviceId, 'c')
  assert.equal(h.store().activeSpeakerProfileKey, 'c')
  assert.deepEqual(h.state.profiles, [2], 'the obsolete default must not apply a profile')
})

test('retry re-enumerates the default instead of reopening a device that has disappeared', async (t) => {
  const h = setup(t)
  const gate = deferred<void>()
  h.state.switchGate = gate.promise
  h.state.failures = 1
  const refreshing = h.store().refreshDevices()
  await flush()
  h.state.devices = outputs('b', ['b', 'c'])
  h.state.switchGate = null
  gate.resolve()
  await refreshing
  assert.deepEqual(h.state.switches, ['a', 'b'])
  assert.equal(h.state.sinkId, 'b')
  assert.equal(h.store().selectedDeviceId, '')
})

test('teardown prevents a failed in-flight switch from retrying or applying profiles', async (t) => {
  const h = setup(t)
  const gate = deferred<void>()
  h.state.switchGate = gate.promise
  h.state.failures = 1
  const refreshing = h.store().refreshDevices()
  await flush()
  h.store().stopDeviceMonitoring()
  h.state.switchGate = null
  gate.resolve()
  await refreshing
  assert.deepEqual(h.state.switches, ['a'])
  assert.deepEqual(h.state.profiles, [])
})

test('returning to Standard restores its explicit device independently of native selection', async (t) => {
  const h = setup(t)
  await h.store().selectDevice('c')
  await h.store().setPlaybackOutputMode('exclusive')
  h.state.devices = outputs('b')
  await h.store().setPlaybackOutputMode('standard')
  assert.equal(h.state.sinkId, 'c')
  assert.equal(h.store().selectedDeviceId, 'c')
  assert.equal(h.storage.get(OUTPUT_KEY), 'c')
})

test('a mode switch drains Standard work and native modes do not follow the default', async (t) => {
  const h = setup(t)
  const gate = deferred<void>()
  h.state.switchGate = gate.promise
  const refreshing = h.store().refreshDevices()
  await flush()
  const changingMode = h.store().setPlaybackOutputMode('exclusive')
  await flush()
  assert.deepEqual(h.state.modeChanges, [])
  h.state.switchGate = null
  gate.resolve()
  await Promise.all([refreshing, changingMode])
  assert.equal(h.store().selectedDeviceId, 'native-a')
  assert.deepEqual(h.state.switches, ['a', 'native-a'])
  h.state.devices = outputs('b')
  await h.store().refreshDevices()
  assert.deepEqual(h.state.switches, ['a', 'native-a'])
  await h.store().setPlaybackOutputMode('bitperfect')
  const switches = h.state.switches.length
  await h.store().refreshDevices()
  assert.equal(h.state.switches.length, switches)
  await h.store().setPlaybackOutputMode('standard')
  assert.equal(h.store().selectedDeviceId, '')
  assert.equal(h.state.sinkId, 'b')
  assert.equal(h.storage.has(OUTPUT_KEY), false)
})

test('monitoring handles events, focus, missed events and cleanup without duplicate timers', async (t) => {
  const h = setup(t)
  t.mock.timers.enable({ apis: ['setInterval'] })
  await h.store().refreshDevices()
  h.store().startDeviceMonitoring()
  h.store().startDeviceMonitoring()
  h.state.devices = outputs('b')
  h.mediaDevices.dispatchEvent(new Event('devicechange'))
  await flush()
  assert.equal(h.state.sinkId, 'b')
  h.state.devices = outputs('c')
  h.windowEvents.dispatchEvent(new Event('focus'))
  await flush()
  assert.equal(h.state.sinkId, 'c')
  h.state.devices = outputs('a')
  const enumerations = h.enumeration.mock.callCount()
  t.mock.timers.tick(2000)
  await flush()
  assert.equal(h.state.sinkId, 'a')
  assert.equal(h.enumeration.mock.callCount(), enumerations + 1)
  await h.store().selectDevice('c')
  const pinnedEnumerations = h.enumeration.mock.callCount()
  t.mock.timers.tick(4000)
  await flush()
  assert.equal(h.enumeration.mock.callCount(), pinnedEnumerations)
  await h.store().selectDevice('')
  h.store().stopDeviceMonitoring()
  const stoppedEnumerations = h.enumeration.mock.callCount()
  h.mediaDevices.dispatchEvent(new Event('devicechange'))
  h.windowEvents.dispatchEvent(new Event('focus'))
  t.mock.timers.tick(4000)
  await flush()
  assert.equal(h.enumeration.mock.callCount(), stoppedEnumerations)
})
