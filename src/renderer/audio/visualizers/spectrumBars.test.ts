import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { SpectrumNativeAnalyzer } from '../native/index.ts'
import type { SpectrumBarNativeConfig } from '../native/visualizer-dsp.d.ts'
import type { FrameScheduler } from './frameScheduler.ts'
import { CLASSIC_SPECTRUM_HEAT_COLORS, resolveSpectrumHeatColors } from './spectrumHeatPalette.ts'

type FrameCallback = () => void

class ManualFrameScheduler {
  private callbacks = new Set<FrameCallback>()
  subscribe(callback: FrameCallback): () => void {
    this.callbacks.add(callback)
    return () => this.callbacks.delete(callback)
  }
  tick(): void {
    for (const callback of [...this.callbacks]) callback()
  }
}

type RoundedRect = { x: number; y: number; width: number; height: number; radius: number }
const roundedRects: RoundedRect[] = []
const fillStyles: string[] = []
let linearGradientCreations = 0

function createContext(): CanvasRenderingContext2D {
  let fillStyle = ''
  return {
    beginPath: () => undefined,
    clearRect: () => undefined,
    closePath: () => undefined,
    createLinearGradient: () => {
      linearGradientCreations += 1
      return { addColorStop: () => undefined } as CanvasGradient
    },
    drawImage: () => undefined,
    fill: () => fillStyles.push(fillStyle),
    fillRect: () => undefined,
    fillText: () => undefined,
    lineTo: () => undefined,
    moveTo: () => undefined,
    roundRect: (x: number, y: number, width: number, height: number, radii?: number | DOMPointInit | Iterable<number | DOMPointInit>) => {
      roundedRects.push({ x, y, width, height, radius: typeof radii === 'number' ? radii : 0 })
    },
    stroke: () => undefined,
    get fillStyle() { return fillStyle },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) { fillStyle = String(value) },
    set font(_value: string) {},
    set lineCap(_value: CanvasLineCap) {},
    set lineJoin(_value: CanvasLineJoin) {},
    set lineWidth(_value: number) {},
    set strokeStyle(_value: string | CanvasGradient | CanvasPattern) {},
    set textAlign(_value: CanvasTextAlign) {},
  } as unknown as CanvasRenderingContext2D
}

class FakeCanvas {
  width: number
  height: number
  style: Partial<CSSStyleDeclaration> = {}
  private context = createContext()
  constructor(width = 320, height = 180) {
    this.width = width
    this.height = height
  }
  getContext(id: string): CanvasRenderingContext2D | null {
    return id === '2d' ? this.context : null
  }
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
Object.defineProperty(globalThis, 'window', { configurable: true, value: { devicePixelRatio: 1 } })
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { createElement: () => new FakeCanvas() },
})

const { SpectrumAnalyzer } = await import('./SpectrumAnalyzer.ts')

function makeNative() {
  let config: SpectrumBarNativeConfig | null = null
  let primaryFrame: Float32Array = new Float32Array(2048).fill(-60)
  let rawFrame: Float32Array = new Float32Array(2048).fill(-60)
  let sideFrame: Float32Array = new Float32Array(2048).fill(-100)
  const frameOptions: Array<{ includeRaw?: boolean; includeSide?: boolean }> = []
  const sideEnabled: boolean[] = []
  const calls = { configure: 0, frame: 0, curveFrame: 0, push: 0, pushStereo: 0, reset: 0 }
  const analyzer: SpectrumNativeAnalyzer = {
    setFFTSize: () => undefined,
    getFFTSize: () => 4096,
    setSampleRate: () => undefined,
    setSmoothing: () => undefined,
    setSideEnabled: (enabled) => { sideEnabled.push(enabled) },
    pushSamples: () => { calls.push += 1 },
    pushStereoSamples: () => { calls.pushStereo += 1 },
    getFrame: (options = {}) => {
      calls.curveFrame += 1
      frameOptions.push({ ...options })
      return {
        primary: primaryFrame,
        ...(options.includeRaw ? { raw: rawFrame } : {}),
        ...(options.includeSide ? { side: sideFrame } : {}),
      }
    },
    process: () => null,
    binToFrequency: () => 0,
    supportsBarFrames: () => true,
    configureBars: (next) => { config = next; calls.configure += 1 },
    getBarFrame: () => {
      calls.frame += 1
      const count = config?.barCount ?? 0
      return Float32Array.from({ length: count * 3 }, (_, index) => {
        if (index % 3 === 0) return 0.6
        if (index % 3 === 1) return 0.75
        return 0.8
      })
    },
    reset: () => { calls.reset += 1 },
    isAvailable: () => true,
  }
  return {
    analyzer,
    calls,
    frameOptions,
    sideEnabled,
    getConfig: () => config,
    setFrames: (frames: { primary?: Float32Array; raw?: Float32Array; side?: Float32Array }) => {
      if (frames.primary) primaryFrame = frames.primary
      if (frames.raw) rawFrame = frames.raw
      if (frames.side) sideFrame = frames.side
    },
  }
}

test('Bars consumes only compact native frames, ignores Side, and clamps rounded geometry', () => {
  roundedRects.length = 0
  fillStyles.length = 0
  const scheduler = new ManualFrameScheduler()
  const native = makeNative()
  let monoReads = 0
  let stereoReads = 0
  const visualizer = new SpectrumAnalyzer(new FakeCanvas() as unknown as HTMLCanvasElement, {
    frameScheduler: scheduler as unknown as FrameScheduler,
    nativeAnalyzer: native.analyzer,
    displayMode: 'bars',
    showSideLine: true,
    heatmapFill: true,
    barDensity: 24,
    barGapPercent: 70,
    barCornerRadiusPx: 12,
    showBarPeaks: true,
    dataSource: {
      getPendingSpectrumSamples: () => { monoReads += 1; return [new Float32Array(64)] },
      getPendingSpectrumStereoSamples: () => { stereoReads += 1; return [] },
      getSampleRate: () => 48000,
      isPlaying: () => true,
      subscribeToSessionChanges: () => () => {},
    },
  })

  visualizer.start()
  scheduler.tick()

  assert.equal(native.getConfig()?.barCount, 77)
  assert.equal(monoReads, 1)
  assert.equal(stereoReads, 0)
  assert.equal(native.calls.curveFrame, 0)
  assert.equal(native.calls.frame, 1)
  assert.equal(roundedRects.length, 154)
  for (const rect of roundedRects) {
    assert.ok(Number.isFinite(rect.x + rect.y + rect.width + rect.height + rect.radius))
    assert.ok(rect.width > 0 && rect.height > 0)
    assert.ok(rect.radius <= rect.width / 2 + 1e-6)
    assert.ok(rect.radius <= rect.height / 2 + 1e-6)
  }
  visualizer.dispose()
})

test('zero-gap bars snap to physical pixels without seams and keep peak caps aligned', () => {
  roundedRects.length = 0
  fillStyles.length = 0
  const scheduler = new ManualFrameScheduler()
  const native = makeNative()
  const canvas = new FakeCanvas(319, 180)
  const visualizer = new SpectrumAnalyzer(canvas as unknown as HTMLCanvasElement, {
    frameScheduler: scheduler as unknown as FrameScheduler,
    nativeAnalyzer: native.analyzer,
    displayMode: 'bars',
    barDensity: 24,
    barGapPercent: 0,
    barCornerRadiusPx: 2,
    showBarPeaks: true,
    dataSource: {
      getPendingSpectrumSamples: () => [new Float32Array(64)],
      getPendingSpectrumStereoSamples: () => [],
      getSampleRate: () => 48000,
      isPlaying: () => true,
      subscribeToSessionChanges: () => () => {},
    },
  })

  visualizer.start()
  scheduler.tick()

  const barCount = native.getConfig()?.barCount ?? 0
  assert.ok(barCount > 0)
  assert.equal(roundedRects.length, barCount * 2)

  const bars = roundedRects.filter((_, index) => index % 2 === 0)
  const peakCaps = roundedRects.filter((_, index) => index % 2 === 1)
  assert.equal(bars[0].x, 0)
  assert.equal(bars[bars.length - 1].x + bars[bars.length - 1].width, canvas.width)

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]
    const peakCap = peakCaps[index]
    assert.ok(Number.isInteger(bar.x))
    assert.ok(Number.isInteger(bar.x + bar.width))
    assert.equal(peakCap.x, bar.x)
    assert.equal(peakCap.width, bar.width)
    if (index > 0) {
      const previousBar = bars[index - 1]
      assert.ok(previousBar.x + previousBar.width >= bar.x)
    }
  }

  visualizer.dispose()
})

test('positive bar gaps preserve intentional spacing', () => {
  roundedRects.length = 0
  fillStyles.length = 0
  const scheduler = new ManualFrameScheduler()
  const native = makeNative()
  const visualizer = new SpectrumAnalyzer(new FakeCanvas(319, 180) as unknown as HTMLCanvasElement, {
    frameScheduler: scheduler as unknown as FrameScheduler,
    nativeAnalyzer: native.analyzer,
    displayMode: 'bars',
    barDensity: 24,
    barGapPercent: 25,
    barCornerRadiusPx: 0,
    showBarPeaks: false,
    dataSource: {
      getPendingSpectrumSamples: () => [new Float32Array(64)],
      getPendingSpectrumStereoSamples: () => [],
      getSampleRate: () => 48000,
      isPlaying: () => true,
      subscribeToSessionChanges: () => () => {},
    },
  })

  visualizer.start()
  scheduler.tick()

  assert.ok(roundedRects.length > 1)
  for (let index = 1; index < roundedRects.length; index += 1) {
    const previousBar = roundedRects[index - 1]
    const bar = roundedRects[index]
    assert.ok(previousBar.x + previousBar.width < bar.x)
  }

  visualizer.dispose()
})

test('Classic heat colors remain exact and Accent derives from effective theme colors', () => {
  assert.deepEqual(CLASSIC_SPECTRUM_HEAT_COLORS, [
    'rgb(15, 7, 33)',
    'rgb(163, 26, 121)',
    'rgb(255, 241, 209)',
  ])
  assert.deepEqual(resolveSpectrumHeatColors('classic', '#123456', '#abcdef', false), CLASSIC_SPECTRUM_HEAT_COLORS)
  assert.deepEqual(resolveSpectrumHeatColors('accent', '#6496c8', '#000000', false), [
    'rgb(30, 45, 60)',
    'rgb(100, 150, 200)',
    'rgb(209, 224, 239)',
  ])
  assert.deepEqual(resolveSpectrumHeatColors('accent', '#6496c8', '#ffffff', true), [
    'rgb(209, 224, 239)',
    'rgb(100, 150, 200)',
    'rgb(30, 45, 60)',
  ])
})

test('a stale native addon does not fall back to JavaScript bar DSP', () => {
  const scheduler = new ManualFrameScheduler()
  const native = makeNative()
  native.analyzer.supportsBarFrames = () => false
  let monoReads = 0
  const visualizer = new SpectrumAnalyzer(new FakeCanvas() as unknown as HTMLCanvasElement, {
    frameScheduler: scheduler as unknown as FrameScheduler,
    nativeAnalyzer: native.analyzer,
    displayMode: 'bars',
    dataSource: {
      getPendingSpectrumSamples: () => { monoReads += 1; return [] },
      getPendingSpectrumStereoSamples: () => { throw new Error('stale addon must not read Side') },
      getSampleRate: () => 48000,
      isPlaying: () => true,
      subscribeToSessionChanges: () => () => {},
    },
  })
  visualizer.start()
  scheduler.tick()
  assert.equal(monoReads, 0)
  assert.equal(native.calls.frame, 0)
  assert.equal(native.calls.curveFrame, 0)
  visualizer.dispose()
})

test('appearance transitions and unchanged DSP options do not reset native spectrum history', () => {
  const scheduler = new ManualFrameScheduler()
  const native = makeNative()
  const visualizer = new SpectrumAnalyzer(new FakeCanvas() as unknown as HTMLCanvasElement, {
    frameScheduler: scheduler as unknown as FrameScheduler,
    nativeAnalyzer: native.analyzer,
    displayMode: 'bars',
    fftSize: 4096,
    smoothing: 0.9,
    heatmapSmoothing: 0.5,
    barDensity: 10,
    showBarPeaks: true,
    dataSource: {
      getPendingSpectrumSamples: () => [new Float32Array(64)],
      getPendingSpectrumStereoSamples: () => [],
      getSampleRate: () => 48000,
      isPlaying: () => true,
      subscribeToSessionChanges: () => () => {},
    },
  })
  visualizer.start()
  scheduler.tick()
  const resetCount = native.calls.reset
  const configureCount = native.calls.configure

  visualizer.setOptions({
    lineColor: '#ff3366',
    backgroundColor: '#100814',
    gridColor: 'rgba(255, 255, 255, 0.12)',
    heatColors: ['rgb(20, 5, 10)', 'rgb(255, 51, 102)', 'rgb(255, 220, 230)'],
    fftSize: 4096,
    smoothing: 0.9,
    heatmapSmoothing: 0.5,
    barDensity: 10,
    showBarPeaks: true,
  })
  scheduler.tick()

  assert.equal(native.calls.reset, resetCount)
  assert.equal(native.calls.configure, configureCount)
  visualizer.dispose()
})

test('curve frames request only the enabled native planes', () => {
  const scheduler = new ManualFrameScheduler()
  const native = makeNative()
  let monoReads = 0
  let stereoReads = 0
  const visualizer = new SpectrumAnalyzer(new FakeCanvas(64, 32) as unknown as HTMLCanvasElement, {
    frameScheduler: scheduler as unknown as FrameScheduler,
    nativeAnalyzer: native.analyzer,
    heatmapFill: false,
    showSideLine: false,
    dataSource: {
      getPendingSpectrumSamples: () => { monoReads += 1; return [new Float32Array(2048)] },
      getPendingSpectrumStereoSamples: () => { stereoReads += 1; return [] },
      getSampleRate: () => 48000,
      isPlaying: () => true,
      subscribeToSessionChanges: () => () => {},
    },
  })

  visualizer.start()
  scheduler.tick()

  assert.equal(monoReads, 1)
  assert.equal(stereoReads, 0)
  assert.deepEqual(native.frameOptions, [{ includeRaw: false, includeSide: false }])
  visualizer.dispose()
})

test('curve geometry and fill gradient are reused across unchanged frames', () => {
  linearGradientCreations = 0
  const scheduler = new ManualFrameScheduler()
  const native = makeNative()
  const visualizer = new SpectrumAnalyzer(new FakeCanvas(64, 32) as unknown as HTMLCanvasElement, {
    frameScheduler: scheduler as unknown as FrameScheduler,
    nativeAnalyzer: native.analyzer,
    dataSource: {
      getPendingSpectrumSamples: () => [new Float32Array(128)],
      getPendingSpectrumStereoSamples: () => [],
      getSampleRate: () => 48000,
      isPlaying: () => true,
      subscribeToSessionChanges: () => () => {},
    },
  })
  const internals = visualizer as unknown as {
    frequencyAtPosition: (position: number, minFrequency: number, maxFrequency: number) => number
  }
  const frequencyAtPosition = internals.frequencyAtPosition.bind(visualizer)
  let frequencyMappings = 0
  internals.frequencyAtPosition = (position, minFrequency, maxFrequency) => {
    frequencyMappings += 1
    return frequencyAtPosition(position, minFrequency, maxFrequency)
  }

  visualizer.start()
  scheduler.tick()
  scheduler.tick()

  assert.equal(frequencyMappings, 128)
  assert.equal(linearGradientCreations, 1)
  visualizer.dispose()
})

test('Heat primes from the current raw frame and does not retain disabled history', () => {
  const scheduler = new ManualFrameScheduler()
  const native = makeNative()
  const visualizer = new SpectrumAnalyzer(new FakeCanvas(64, 32) as unknown as HTMLCanvasElement, {
    frameScheduler: scheduler as unknown as FrameScheduler,
    nativeAnalyzer: native.analyzer,
    heatmapFill: false,
    heatmapSmoothing: 0.5,
    fftSize: 4096,
    dataSource: {
      getPendingSpectrumSamples: () => [new Float32Array(4096)],
      getPendingSpectrumStereoSamples: () => [],
      getSampleRate: () => 48000,
      isPlaying: () => true,
      subscribeToSessionChanges: () => () => {},
    },
  })
  const state = visualizer as unknown as { heatmapMagnitudeBuffer: Float32Array }

  visualizer.start()
  scheduler.tick()
  native.setFrames({ raw: new Float32Array(2048).fill(-40) })
  visualizer.setOptions({ heatmapFill: true })
  scheduler.tick()
  assert.equal(state.heatmapMagnitudeBuffer[100], -40)

  native.setFrames({ raw: new Float32Array(2048).fill(-20) })
  scheduler.tick()
  assert.equal(state.heatmapMagnitudeBuffer[100], -30)

  visualizer.setOptions({ heatmapFill: false })
  scheduler.tick()
  native.setFrames({ raw: new Float32Array(2048).fill(-10) })
  visualizer.setOptions({ heatmapFill: true })
  scheduler.tick()
  assert.equal(state.heatmapMagnitudeBuffer[100], -10)
  assert.equal(native.frameOptions.filter((options) => options.includeRaw).length, 3)
  visualizer.dispose()
})

test('Side enablement switches DSP input without resetting primary history', () => {
  const scheduler = new ManualFrameScheduler()
  const native = makeNative()
  let monoReads = 0
  let stereoReads = 0
  const visualizer = new SpectrumAnalyzer(new FakeCanvas(64, 32) as unknown as HTMLCanvasElement, {
    frameScheduler: scheduler as unknown as FrameScheduler,
    nativeAnalyzer: native.analyzer,
    showSideLine: false,
    dataSource: {
      getPendingSpectrumSamples: () => { monoReads += 1; return [new Float32Array(128)] },
      getPendingSpectrumStereoSamples: () => {
        stereoReads += 1
        return [{ left: new Float32Array(128), right: new Float32Array(128) }]
      },
      getSampleRate: () => 48000,
      isPlaying: () => true,
      subscribeToSessionChanges: () => () => {},
    },
  })

  visualizer.start()
  scheduler.tick()
  const resetsBeforeToggle = native.calls.reset
  visualizer.setOptions({ showSideLine: true })
  scheduler.tick()
  visualizer.setOptions({ showSideLine: false })
  scheduler.tick()

  assert.deepEqual(native.sideEnabled, [false, true, false])
  assert.equal(native.calls.reset, resetsBeforeToggle)
  assert.equal(monoReads, 2)
  assert.equal(stereoReads, 1)
  assert.equal(native.calls.push, 2)
  assert.equal(native.calls.pushStereo, 1)
  assert.deepEqual(native.frameOptions.map((options) => Boolean(options.includeSide)), [false, true, false])
  visualizer.dispose()
})

test.after(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else Reflect.deleteProperty(globalThis, 'document')
})
