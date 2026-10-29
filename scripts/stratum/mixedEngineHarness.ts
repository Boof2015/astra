// Silent browser boundary: real AudioEngine and worklet; only the Web Audio
// graph/clock and IPC wiring are simulated. Never opens a device or Electron.
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { AudioEngine } from '../../src/renderer/audio/AudioEngine.ts'
import type { mixedHarness } from './mixedHarness.ts'

export function mixedEngineHarness(h: ReturnType<typeof mixedHarness>, rate = 44100) {
  const saved = ['window', 'AudioWorkletNode'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  let frame = 0, Processor: any
  const sources: any[] = [], nodes: any[] = [], errors: unknown[] = []
  const activated: number[] = []
  const context: any = { sampleRate: rate, state: 'running', get currentTime() { return frame / rate },
    createBuffer: (channels: number, frames: number, sampleRate: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(frames))
      return { sampleRate, numberOfChannels: channels, length: frames, duration: frames / sampleRate,
        getChannelData: (channel: number) => data[channel] }
    },
    createBufferSource: () => {
      const source: any = { buffer: null, onended: null, begin: Infinity, end: Infinity, offset: 0,
        disconnected: false, ended: false, connect() {}, disconnect() { this.disconnected = true },
        start(when = 0, offset = 0) { this.begin = Math.max(frame, Math.round(when * rate)); this.offset = Math.round(offset * rate) },
        stop(when = 0) { this.end = Math.max(frame, Math.round(when * rate)) } }
      sources.push(source)
      return source
    } }
  runInNewContext(readFileSync(new URL('../../src/renderer/public/oscilloscope-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: () => {} } },
    registerProcessor: (name: string, value: any) => { if (name === 'remote-stream-player') Processor = value },
    Float32Array, sampleRate: rate, get currentFrame() { return frame }
  })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
    startProgressiveStream: h.startOptions,
    cancelProgressiveStream: h.cancel,
    cancelPendingProgressiveStream: async (slot: string) => { h.registry.cancel(1, slot === 'next' ? 'next' : 'current') },
    updateProgressiveStreamPosition: h.position,
    activateProgressiveStream: (id: number) => { activated.push(id); const session = h.sessions.get(id); if (session) session.slot = 'current' }
  } } })
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: class {
    processor: any
    disconnected = false
    port = { onmessage: null as any, postMessage: (data: any) => this.processor.port.onmessage({ data }) }
    constructor(_context: unknown, _name: string, options: unknown) {
      this.processor = new Processor(options)
      this.processor.port.postMessage = (data: unknown) => queueMicrotask(() => this.port.onmessage?.({ data }))
      nodes.push(this)
    }
    connect() { this.disconnected = false }
    disconnect() { this.disconnected = true }
  } })
  const engine = new AudioEngine()
  const internal = engine as any
  internal.context = context
  internal.workletLoaded = true
  internal.initContext = async () => {}
  internal._normalizationEnabled = false
  for (const name of ['connectSourceWithRouting', 'connectSourceToAnalysisTap', 'disconnectSourceRouting',
    'applyChannelRoutingPreferences', 'applyAnalysisRoutingPreferences', 'applyGainState', 'startTimeUpdate']) internal[name] = () => {}
  engine.on('error', error => { errors.push(error) })
  return { engine, internal, errors, activated,
    deliver: (channel: string, value: unknown) => {
      if (channel === 'audio:progressiveStreamChunk') internal.handleRemoteStreamChunk(value)
      if (channel === 'audio:progressiveStreamEvent') internal.handleRemoteStreamEvent(value)
    },
    render: async (frames: number) => {
      const output = [new Float32Array(frames), new Float32Array(frames)]
      for (const source of sources) {
        if (source.disconnected || !source.buffer || source.ended) continue
        const end = Math.min(source.end, source.begin + source.buffer.length - source.offset)
        for (let i = 0; i < frames; i++) {
          if (frame + i < source.begin || frame + i >= end) continue
          for (let c = 0; c < 2; c++) output[c][i] += source.buffer.getChannelData(c)[frame + i - source.begin + source.offset]
        }
        if (frame + frames >= end) { source.ended = true; queueMicrotask(() => source.onended?.()) }
      }
      for (const node of nodes) {
        if (node.disconnected) continue
        const block = [new Float32Array(frames), new Float32Array(frames)]
        node.processor.process([], [block])
        for (let c = 0; c < 2; c++) for (let i = 0; i < frames; i++) output[c][i] += block[c][i]
      }
      frame += frames
      await new Promise<void>(resolve => setImmediate(resolve))
      return output
    },
    close: async () => {
      await engine.stop()
      await new Promise<void>(resolve => setImmediate(resolve))
      for (const [name, value] of saved) {
        if (value) Object.defineProperty(globalThis, name, value)
        else delete (globalThis as any)[name]
      }
    }
  }
}
