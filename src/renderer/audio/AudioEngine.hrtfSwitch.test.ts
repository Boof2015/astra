import assert from 'node:assert/strict'
import test from 'node:test'
import { builtinHrtfProfile, type HrtfProfileSummary } from '../../types/hrtfProfiles.ts'
import { AudioEngine } from './AudioEngine.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function imported(id: string): HrtfProfileSummary {
  return { id: `sofa:${id}`, name: id, kind: 'sofa', builtIn: false, importedAt: new Date(0).toISOString(), sizeBytes: 100 }
}

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  terminated = false
  posted: unknown[] = []

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  terminate(): void {
    this.terminated = true
  }
}

class FakeNode {
  port = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: (_message: unknown) => undefined }
  disconnected = false

  disconnect(): void {
    this.disconnected = true
  }
}

class FakeAudioParam {
  value = 0
  values: Array<{ value: number; time: number }> = []
  curves: Array<{ values: number[]; start: number; duration: number }> = []

  setValueAtTime(value: number, time: number): void {
    this.value = value
    this.values.push({ value, time })
  }

  setValueCurveAtTime(values: Float32Array, start: number, duration: number): void {
    this.curves.push({ values: [...values], start, duration })
  }
}

class FakeGainNode extends FakeNode {
  gain = new FakeAudioParam()
}

type Prepared = {
  worker: FakeWorker
  config: { sampleRate: number; blockSize: number; taps: number; fftSize: number; fftBins: number; filterLen: number }
  filters: []
}

type RendererInstance = {
  node: FakeNode
  outputGain: FakeGainNode
  prepWorker: FakeWorker
  profile: HrtfProfileSummary
  taps: number
}

type HrtfEngineInternals = {
  context: { sampleRate: number; currentTime: number } | null
  spatialMode: 'off' | 'binaural'
  playbackOutputMode: 'standard' | 'exclusive' | 'bitperfect'
  spatialInputNode: { disconnect: (node?: unknown) => void } | null
  normalizationGainNode: unknown
  spatialWorkletNode: FakeNode | null
  spatialOutputGainNode: FakeGainNode | null
  spatialPrepWorker: FakeWorker | null
  spatialProfile: HrtfProfileSummary
  spatialWorkletState: 'idle' | 'loading' | 'ready' | 'error' | 'unsupported-samplerate'
  spatialStatusMessage: string | null
  spatialProfileSwitchGeneration: number
  initContext: () => Promise<void>
  prepareHrtfProfile: (profile: HrtfProfileSummary, requestId: number) => Promise<Prepared>
  createPreparedSpatialRenderer: (profile: HrtfProfileSummary, prepared: Prepared) => Promise<RendererInstance>
  activateSpatialRenderer: (instance: RendererInstance) => Promise<boolean>
}

function readyEngine(): { engine: AudioEngine; internals: HrtfEngineInternals } {
  const engine = new AudioEngine()
  const internals = engine as unknown as HrtfEngineInternals
  internals.spatialMode = 'binaural'
  internals.playbackOutputMode = 'standard'
  internals.context = { sampleRate: 48000, currentTime: 10 }
  internals.spatialInputNode = { disconnect: () => undefined }
  internals.normalizationGainNode = {}
  internals.initContext = async () => undefined
  return { engine, internals }
}

test('profile activation primes, equal-power crossfades, and cleans up the old renderer', async () => {
  const { internals } = readyEngine()
  const oldNode = new FakeNode()
  const oldGain = new FakeGainNode()
  oldGain.gain.value = 1
  const oldWorker = new FakeWorker()
  const disconnectedInputs: unknown[] = []
  internals.spatialInputNode = { disconnect: (node) => disconnectedInputs.push(node) }
  internals.spatialWorkletNode = oldNode
  internals.spatialOutputGainNode = oldGain
  internals.spatialPrepWorker = oldWorker
  internals.spatialProfile = builtinHrtfProfile()
  internals.spatialWorkletState = 'ready'

  const next: RendererInstance = {
    node: new FakeNode(),
    outputGain: new FakeGainNode(),
    prepWorker: new FakeWorker(),
    profile: imported('crossfade'),
    taps: 512,
  }
  const originalWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { setTimeout: globalThis.setTimeout.bind(globalThis) },
  })
  try {
    await internals.activateSpatialRenderer(next)
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  }

  const expectedStart = 10 + (2 * 128) / 48000
  assert.equal(next.outputGain.gain.curves.length, 1)
  assert.equal(oldGain.gain.curves.length, 1)
  assert.ok(Math.abs(next.outputGain.gain.curves[0].start - expectedStart) < 1e-9)
  assert.equal(next.outputGain.gain.curves[0].duration, 0.05)
  assert.equal(next.outputGain.gain.curves[0].values[0], 0)
  assert.ok(Math.abs(next.outputGain.gain.curves[0].values.at(-1)! - 1) < 1e-6)
  assert.equal(oldGain.gain.curves[0].values[0], 1)
  assert.ok(Math.abs(oldGain.gain.curves[0].values.at(-1)!) < 1e-6)
  assert.deepEqual(disconnectedInputs, [oldNode])
  assert.equal(oldNode.disconnected, true)
  assert.equal(oldGain.disconnected, true)
  assert.equal(oldWorker.terminated, true)
  assert.equal(internals.spatialWorkletNode, next.node)
  assert.equal(internals.spatialProfile.id, next.profile.id)
})

test('the latest profile request wins and a stale prepared worker is discarded', async () => {
  const { engine, internals } = readyEngine()
  const first = imported('first')
  const second = imported('second')
  const firstPrepared = deferred<Prepared>()
  const secondPrepared = deferred<Prepared>()
  const created: string[] = []
  const activated: string[] = []

  internals.prepareHrtfProfile = (profile) => profile.id === first.id ? firstPrepared.promise : secondPrepared.promise
  internals.createPreparedSpatialRenderer = async (profile, prepared) => {
    created.push(profile.id)
    return { node: new FakeNode(), outputGain: new FakeGainNode(), prepWorker: prepared.worker, profile, taps: 256 }
  }
  internals.activateSpatialRenderer = async (instance) => {
    activated.push(instance.profile.id)
    internals.spatialWorkletNode = instance.node
    internals.spatialOutputGainNode = instance.outputGain
    internals.spatialPrepWorker = instance.prepWorker
    internals.spatialProfile = instance.profile
    internals.spatialWorkletState = 'ready'
    return true
  }

  const firstRequest = engine.setHrtfProfile(first)
  const secondRequest = engine.setHrtfProfile(second)
  const secondWorker = new FakeWorker()
  secondPrepared.resolve({
    worker: secondWorker,
    config: { sampleRate: 48000, blockSize: 128, taps: 256, fftSize: 1024, fftBins: 513, filterLen: 896 },
    filters: [],
  })
  assert.equal(await secondRequest, true)

  const staleWorker = new FakeWorker()
  firstPrepared.resolve({
    worker: staleWorker,
    config: { sampleRate: 48000, blockSize: 128, taps: 256, fftSize: 1024, fftBins: 513, filterLen: 896 },
    filters: [],
  })
  assert.equal(await firstRequest, false)
  assert.equal(staleWorker.terminated, true)
  assert.deepEqual(created, [second.id])
  assert.deepEqual(activated, [second.id])
  assert.equal(internals.spatialProfile.id, second.id)
})

test('failed preparation preserves the active renderer and profile', async () => {
  const { engine, internals } = readyEngine()
  const oldNode = new FakeNode()
  const oldGain = new FakeGainNode()
  const oldWorker = new FakeWorker()
  internals.spatialWorkletNode = oldNode
  internals.spatialOutputGainNode = oldGain
  internals.spatialPrepWorker = oldWorker
  internals.spatialProfile = imported('working')
  internals.spatialWorkletState = 'ready'
  internals.prepareHrtfProfile = async () => {
    throw { code: 'invalid-sofa', message: 'The candidate is truncated.' }
  }

  assert.equal(await engine.setHrtfProfile(imported('broken')), false)
  assert.equal(internals.spatialWorkletNode, oldNode)
  assert.equal(internals.spatialOutputGainNode, oldGain)
  assert.equal(internals.spatialPrepWorker, oldWorker)
  assert.equal(internals.spatialProfile.id, 'sofa:working')
  assert.equal(internals.spatialWorkletState, 'ready')
  assert.equal(internals.spatialStatusMessage, 'The candidate is truncated.')
  assert.equal(oldWorker.terminated, false)
})
