import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { FrameScheduler } from './frameScheduler.ts'

type FrameCallback = () => void

interface VisualizerInstance {
  start(): void
  dispose(): void
}

class ManualFrameScheduler {
  private callbacks = new Set<FrameCallback>()

  subscribe(callback: FrameCallback): () => void {
    this.callbacks.add(callback)
    return () => {
      this.callbacks.delete(callback)
    }
  }

  tick(): void {
    for (const callback of [...this.callbacks]) {
      callback()
    }
  }

  get callbackCount(): number {
    return this.callbacks.size
  }
}

function createCanvasGradient(): CanvasGradient {
  return {
    addColorStop: () => undefined,
  } as unknown as CanvasGradient
}

function createCanvasContext(): CanvasRenderingContext2D {
  return {
    beginPath: () => undefined,
    clearRect: () => undefined,
    closePath: () => undefined,
    createLinearGradient: () => createCanvasGradient(),
    drawImage: () => undefined,
    fill: () => undefined,
    fillRect: () => undefined,
    fillText: () => undefined,
    lineTo: () => undefined,
    moveTo: () => undefined,
    stroke: () => undefined,
    set fillStyle(_value: string | CanvasGradient | CanvasPattern) {},
    set font(_value: string) {},
    set globalAlpha(_value: number) {},
    set lineCap(_value: CanvasLineCap) {},
    set lineJoin(_value: CanvasLineJoin) {},
    set lineWidth(_value: number) {},
    set strokeStyle(_value: string | CanvasGradient | CanvasPattern) {},
    set textAlign(_value: CanvasTextAlign) {},
  } as unknown as CanvasRenderingContext2D
}

class FakeCanvas {
  width = 320
  height = 180
  style: Partial<CSSStyleDeclaration> = {}
  private readonly context = createCanvasContext()

  getContext(contextId: string): CanvasRenderingContext2D | null {
    return contextId === '2d' ? this.context : null
  }
}

const warnCalls: unknown[][] = []
const errorCalls: unknown[][] = []
const originalWarn = console.warn
const originalError = console.error
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')

console.warn = ((...args: unknown[]) => {
  warnCalls.push(args)
}) as typeof console.warn
console.error = ((...args: unknown[]) => {
  errorCalls.push(args)
}) as typeof console.error

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    devicePixelRatio: 1,
  },
})

Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    createElement: (tagName: string) => {
      assert.equal(tagName, 'canvas')
      return new FakeCanvas()
    },
  },
})

function restoreGlobalProperty(propertyName: 'window' | 'document', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(globalThis, propertyName, descriptor)
  } else {
    Reflect.deleteProperty(globalThis, propertyName)
  }
}

const { audioEngine } = await import('../AudioEngine.ts')
const { Oscilloscope } = await import('./Oscilloscope.ts')
const { SpectrumAnalyzer } = await import('./SpectrumAnalyzer.ts')

function expectStopsAfterOneFrame(createVisualizer: (scheduler: FrameScheduler) => VisualizerInstance): void {
  const scheduler = new ManualFrameScheduler()
  const visualizer = createVisualizer(scheduler as unknown as FrameScheduler)

  visualizer.start()
  assert.equal(scheduler.callbackCount, 1)

  scheduler.tick()
  assert.equal(scheduler.callbackCount, 0)

  scheduler.tick()
  assert.equal(scheduler.callbackCount, 0)

  visualizer.dispose()
}

test('native-only visualizers warn once and stop retrying when native DSP is unavailable', () => {
  const playbackStateTarget = audioEngine as unknown as { _playbackState: string }
  playbackStateTarget._playbackState = 'playing'

  try {
    expectStopsAfterOneFrame((frameScheduler) => new Oscilloscope(
      new FakeCanvas() as unknown as HTMLCanvasElement,
      { frameScheduler }
    ))

    expectStopsAfterOneFrame((frameScheduler) => new SpectrumAnalyzer(
      new FakeCanvas() as unknown as HTMLCanvasElement,
      {
        frameScheduler,
        dataSource: {
          getPendingSpectrumSamples: () => {
            throw new Error('missing-native spectrum should not consume samples')
          },
          getPendingSpectrumStereoSamples: () => {
            throw new Error('missing-native spectrum should not consume stereo samples')
          },
          getSampleRate: () => 48000,
          isPlaying: () => true,
          subscribeToSessionChanges: () => () => {},
        },
      }
    ))

    assert.equal(warnCalls.length, 0)
    assert.equal(errorCalls.length, 1)
    assert.match(String(errorCalls[0][0]), /Native module not found in window\.visualizerAPI/)
  } finally {
    playbackStateTarget._playbackState = 'stopped'
    console.warn = originalWarn
    console.error = originalError
    restoreGlobalProperty('window', originalWindowDescriptor)
    restoreGlobalProperty('document', originalDocumentDescriptor)
  }
})
