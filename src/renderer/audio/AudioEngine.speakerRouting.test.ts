import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioEngine } from './AudioEngine.ts'
import { normalizeDeviceSpeakerProfile, type DeviceSpeakerProfile } from '../utils/speakerLayout.ts'

function assertNear(actual: number | null | undefined, expected: number): void {
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `expected ${actual} near ${expected}`)
}

class FakeAudioParam {
  value = 1
  events: Array<[string, number, number]> = []

  cancelScheduledValues(time: number): void {
    this.events.push(['cancel', this.value, time])
  }

  setValueAtTime(value: number, time: number): void {
    this.value = value
    this.events.push(['set', value, time])
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.value = value
    this.events.push(['ramp', value, time])
  }
}

interface FakeConnection {
  destination: FakeNode
  output: number
  input: number
}

class FakeNode {
  channelCount = 2
  channelCountMode: ChannelCountMode = 'max'
  channelInterpretation: ChannelInterpretation = 'speakers'
  connections: FakeConnection[] = []
  disconnected = false

  connect(destination: FakeNode, output = 0, input = 0): FakeNode {
    this.connections.push({ destination, output, input })
    return destination
  }

  disconnect(): void {
    this.connections = []
    this.disconnected = true
  }
}

class FakeGainNode extends FakeNode {
  gain = new FakeAudioParam()
}

class FakeFilterNode extends FakeNode {
  type: BiquadFilterType = 'lowpass'
  frequency = new FakeAudioParam()
  Q = new FakeAudioParam()
}

class FakeBufferSourceNode extends FakeNode {
  buffer: AudioBuffer | null = null
  onended: (() => void) | null = null
  startedAt: number | null = null
  stoppedAt: number | null = null

  start(time: number): void {
    this.startedAt = time
  }

  stop(time = 0): void {
    this.stoppedAt = time
  }
}

class FakeConstantSourceNode extends FakeNode {
  offset = new FakeAudioParam()
  started = false
  stopped = false

  start(): void {
    this.started = true
  }

  stop(): void {
    this.stopped = true
  }
}

class FakeDestinationNode extends FakeNode {
  maxChannelCount = 26
}

class FakeAudioContext {
  currentTime = 10
  sampleRate = 48_000
  state: AudioContextState = 'running'
  destination = new FakeDestinationNode()
  splitters: Array<FakeNode & { numberOfOutputs: number }> = []
  mergers: Array<FakeNode & { numberOfInputs: number }> = []
  constants: FakeConstantSourceNode[] = []
  gains: FakeGainNode[] = []
  sources: FakeBufferSourceNode[] = []

  createChannelSplitter(outputs: number): ChannelSplitterNode {
    const node = Object.assign(new FakeNode(), { numberOfOutputs: outputs })
    this.splitters.push(node)
    return node as unknown as ChannelSplitterNode
  }

  createChannelMerger(inputs: number): ChannelMergerNode {
    const node = Object.assign(new FakeNode(), { numberOfInputs: inputs })
    this.mergers.push(node)
    return node as unknown as ChannelMergerNode
  }

  createConstantSource(): ConstantSourceNode {
    const node = new FakeConstantSourceNode()
    this.constants.push(node)
    return node as unknown as ConstantSourceNode
  }

  createGain(): GainNode {
    const node = new FakeGainNode()
    this.gains.push(node)
    return node as unknown as GainNode
  }

  createBiquadFilter(): BiquadFilterNode {
    return new FakeFilterNode() as unknown as BiquadFilterNode
  }

  createBufferSource(): AudioBufferSourceNode {
    const node = new FakeBufferSourceNode()
    this.sources.push(node)
    return node as unknown as AudioBufferSourceNode
  }

  createBuffer(_channels: number, frames: number, sampleRate: number): AudioBuffer {
    const samples = new Float32Array(frames)
    return {
      length: frames,
      sampleRate,
      getChannelData: () => samples,
    } as unknown as AudioBuffer
  }

  async resume(): Promise<void> {
    this.state = 'running'
  }
}

type SpeakerRoutingInternals = {
  context: AudioContext | null
  programDuckGainNode: GainNode | null
  hardwareMapperNodes: AudioNode[]
  speakerProfile: DeviceSpeakerProfile
  deviceMaxOutputChannels: number
  playbackOutputMode: 'standard' | 'exclusive' | 'bitperfect'
  spatialMode: 'off' | 'binaural'
  spatialWorkletState: 'idle' | 'loading' | 'ready' | 'error' | 'unsupported-samplerate'
  spatialWorkletNode: AudioWorkletNode | null
  spatialInputNode: GainNode | null
  virtualSpeakers: Array<{ id: string; sourceChannel: string; azimuth: number; elevation: number; gain: number }>
  activeSpeakerTestRole: string | null
  multichannelEnabled: boolean
  rebuildHardwareOutputRouting: () => void
  rebuildRemoteStreamRoutingIfActive: () => boolean
  rebuildParallaxSinkRoutingIfActive: () => boolean
  initContext: () => Promise<void>
}

function preparedEngine(profile: DeviceSpeakerProfile): {
  engine: AudioEngine
  internals: SpeakerRoutingInternals
  context: FakeAudioContext
  program: FakeGainNode
} {
  const engine = new AudioEngine()
  const internals = engine as unknown as SpeakerRoutingInternals
  const context = new FakeAudioContext()
  const program = new FakeGainNode()
  internals.context = context as unknown as AudioContext
  internals.programDuckGainNode = program as unknown as GainNode
  internals.speakerProfile = profile
  internals.deviceMaxOutputChannels = 26
  internals.playbackOutputMode = 'standard'
  internals.spatialMode = 'off'
  internals.spatialWorkletState = 'idle'
  internals.initContext = async () => undefined
  return { engine, internals, context, program }
}

test('26-output Quad keeps a four-channel logical and physical bus', () => {
  const profile = normalizeDeviceSpeakerProfile({
    layoutId: 'quad',
    outputMap: { FL: 0, FR: 1, SL: 2, SR: 3 },
  }, 26)
  const { internals, context } = preparedEngine(profile)
  internals.rebuildHardwareOutputRouting()

  assert.equal(context.splitters.at(-1)?.numberOfOutputs, 4)
  assert.equal(context.mergers.at(-1)?.numberOfInputs, 4)
  assert.equal(context.destination.channelCount, 4)
  assert.equal(context.constants.length, 0)
})

test('sparse Quad builds an 18-channel hardware bus with silence in every gap', () => {
  const profile = normalizeDeviceSpeakerProfile({
    layoutId: 'quad',
    outputMap: { FL: 0, FR: 1, SL: 16, SR: 17 },
  }, 26)
  const { internals, context } = preparedEngine(profile)
  internals.rebuildHardwareOutputRouting()

  const splitter = context.splitters.at(-1)!
  const merger = context.mergers.at(-1)!
  assert.equal(splitter.numberOfOutputs, 4)
  assert.equal(merger.numberOfInputs, 18)
  assert.deepEqual(
    splitter.connections.map((connection) => [connection.output, connection.input]),
    [[0, 0], [1, 1], [2, 16], [3, 17]]
  )
  assert.equal(context.constants.length, 1)
  assert.deepEqual(
    context.constants[0].connections.map((connection) => connection.input),
    Array.from({ length: 14 }, (_, index) => index + 2)
  )
})

test('active Binaural playback bypasses the Direct physical profile', () => {
  const profile = normalizeDeviceSpeakerProfile({
    layoutId: 'quad',
    outputMap: { FL: 0, FR: 1, SL: 16, SR: 17 },
  }, 26)
  const { internals, context, program } = preparedEngine(profile)
  internals.spatialMode = 'binaural'
  internals.spatialWorkletState = 'ready'
  internals.spatialWorkletNode = new FakeNode() as unknown as AudioWorkletNode
  internals.spatialInputNode = new FakeGainNode() as unknown as GainNode
  internals.virtualSpeakers = [
    { id: 'vs-FL', sourceChannel: 'FL', azimuth: -30, elevation: 0, gain: 1 },
    { id: 'vs-FR', sourceChannel: 'FR', azimuth: 30, elevation: 0, gain: 1 },
  ]
  internals.rebuildHardwareOutputRouting()

  assert.equal(context.splitters.length, 0)
  assert.equal(context.destination.channelCount, 2)
  assert.equal(program.connections[0]?.destination, context.destination)
})

test('speaker test targets the mapped hardware output and restores ducking', async () => {
  const profile = normalizeDeviceSpeakerProfile({
    layoutId: 'quad',
    outputMap: { FL: 0, FR: 1, SL: 16, SR: 17 },
  }, 26)
  const { engine, internals, context, program } = preparedEngine(profile)
  const played = await engine.playSpeakerTestTone('SL')

  assert.equal(played, true)
  assert.equal(internals.activeSpeakerTestRole, 'SL')
  assert.equal(context.mergers.at(-1)?.numberOfInputs, 18)
  assert.ok(context.gains.some((gain) => gain.connections.some((connection) => connection.input === 16)))
  const duckRamp = program.gain.events.find(([kind, value]) => kind === 'ramp' && value < 0.13)
  assertNear(duckRamp?.[2], 10.04)
  assertNear(context.sources.at(-1)?.startedAt, 10.05)
  assertNear(context.sources.at(-1)?.stoppedAt, 10.8)
  assert.deepEqual(context.gains[0]?.gain.events.map(([kind, value]) => [kind, value]), [
    ['set', 0],
    ['ramp', 1],
    ['set', 1],
    ['ramp', 0],
  ])
  const envelopeTimes = context.gains[0]?.gain.events.map((event) => event[2]) ?? []
  for (const [index, expected] of [10.05, 10.1, 10.75, 10.8].entries()) {
    assertNear(envelopeTimes[index], expected)
  }

  engine.stopSpeakerTestTone()
  assert.equal(internals.activeSpeakerTestRole, null)
  const restoreRamp = program.gain.events.find(([kind, value]) => kind === 'ramp' && value === 1)
  assertNear(restoreRamp?.[2], 10.12)
})

test('hardware-only edits rebuild the final mapper without rebuilding source routing', async () => {
  const profile = normalizeDeviceSpeakerProfile({
    layoutId: 'quad',
    outputMap: { FL: 0, FR: 1, SL: 2, SR: 3 },
  }, 26)
  const { engine, internals, context } = preparedEngine(profile)
  internals.multichannelEnabled = true
  let sourceRebuilds = 0
  internals.rebuildRemoteStreamRoutingIfActive = () => {
    sourceRebuilds += 1
    return true
  }
  internals.rebuildParallaxSinkRoutingIfActive = () => false

  await engine.setSpeakerOutputConfiguration(normalizeDeviceSpeakerProfile({
    layoutId: 'quad',
    outputMap: { FL: 0, FR: 1, SL: 16, SR: 17 },
  }, 26), 26)
  assert.equal(sourceRebuilds, 0)
  assert.equal(context.mergers.at(-1)?.numberOfInputs, 18)

  await engine.setSpeakerOutputConfiguration(normalizeDeviceSpeakerProfile({
    layoutId: '5.1',
    outputMap: { FL: 0, FR: 1, FC: 2, LFE: 3, SL: 4, SR: 5 },
  }, 26), 26)
  assert.equal(sourceRebuilds, 1)
})
