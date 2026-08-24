import { strict as assert } from 'node:assert'
import test, { after } from 'node:test'
import type { LUFSMeterNativeAnalyzer, LUFSMeterNativeSnapshot } from '../native/index.ts'
import type { FrameScheduler } from './frameScheduler.ts'

type FrameCallback = () => void
type DrawRect = { x: number; y: number; width: number; height: number; style: string }
type DrawText = {
  text: string
  x: number
  y: number
  width: number
  align: CanvasTextAlign
  style: string
}

const LINE_COLOR = '#123456'
const TRACK_COLOR = '#111111'
const TARGET_COLOR = '#222222'
const SCALE_COLOR = '#333333'

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

class RecordingContext {
  readonly rects: DrawRect[] = []
  readonly texts: DrawText[] = []
  fillStyle: string | CanvasGradient | CanvasPattern = ''
  font = '10px sans-serif'
  textAlign: CanvasTextAlign = 'start'
  textBaseline: CanvasTextBaseline = 'alphabetic'

  clearRect(): void {}

  fillRect(x: number, y: number, width: number, height: number): void {
    this.rects.push({ x, y, width, height, style: String(this.fillStyle) })
  }

  fillText(text: string, x: number, y: number): void {
    this.texts.push({
      text,
      x,
      y,
      width: this.measureText(text).width,
      align: this.textAlign,
      style: String(this.fillStyle),
    })
  }

  measureText(text: string): TextMetrics {
    const fontSize = Number.parseFloat(/([\d.]+)px/.exec(this.font)?.[1] ?? '10')
    return { width: text.length * fontSize * 0.6 } as TextMetrics
  }
}

class FakeCanvas {
  readonly context = new RecordingContext()
  readonly cssWidth: number
  readonly cssHeight: number
  readonly width: number
  readonly height: number
  readonly style: Partial<CSSStyleDeclaration>

  constructor(
    cssWidth: number,
    cssHeight: number,
    requestedPixelRatio: number,
  ) {
    this.cssWidth = cssWidth
    this.cssHeight = cssHeight
    this.width = Math.round(cssWidth * requestedPixelRatio)
    this.height = Math.round(cssHeight * requestedPixelRatio)
    this.style = {
      width: `${cssWidth}px`,
      height: `${cssHeight}px`,
    }
  }

  get pixelRatio(): number {
    return this.width / this.cssWidth
  }

  getContext(contextId: string): CanvasRenderingContext2D | null {
    return contextId === '2d'
      ? this.context as unknown as CanvasRenderingContext2D
      : null
  }
}

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalConsoleError = console.error

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    devicePixelRatio: 1,
    getComputedStyle: () => ({
      getPropertyValue: () => '',
    }),
  },
})
console.error = () => undefined

const { LUFSMeter } = await import('./LUFSMeter.ts')

console.error = originalConsoleError

after(() => {
  console.error = originalConsoleError
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, 'window')
  }
})

const ACTIVE_SNAPSHOT: LUFSMeterNativeSnapshot = {
  momentaryLUFS: -7.5,
  shortTermLUFS: -8.7,
  integratedLUFS: -10.2,
  vuLDb: -12,
  vuRDb: -13,
  barLDb: -9,
  barRDb: -11,
  peakLDb: -5,
  peakRDb: -6,
  correlation: 0.8,
}

function createNativeAnalyzer(snapshot: LUFSMeterNativeSnapshot): LUFSMeterNativeAnalyzer {
  return {
    setSampleRate: () => undefined,
    pushSamples: () => undefined,
    getSnapshot: () => snapshot,
    reset: () => undefined,
    isAvailable: () => true,
  }
}

interface RenderResult {
  canvas: FakeCanvas
  target: DrawRect
  tag: DrawRect
  tracks: DrawRect[]
  readout: DrawText
}

function renderMeter({
  cssWidth,
  cssHeight = 196,
  pixelRatio = 1,
  snapshot = ACTIVE_SNAPSHOT,
}: {
  cssWidth: number
  cssHeight?: number
  pixelRatio?: number
  snapshot?: LUFSMeterNativeSnapshot
}): RenderResult {
  const scheduler = new ManualFrameScheduler()
  const canvas = new FakeCanvas(cssWidth, cssHeight, pixelRatio)
  const visualizer = new LUFSMeter(canvas as unknown as HTMLCanvasElement, {
    frameScheduler: scheduler as unknown as FrameScheduler,
    nativeAnalyzer: createNativeAnalyzer(snapshot),
    lineColor: LINE_COLOR,
    trackColor: TRACK_COLOR,
    targetColor: TARGET_COLOR,
    scaleColor: SCALE_COLOR,
    dataSource: {
      getPendingLUFSMeterSamples: () => [],
      getSampleRate: () => 48000,
      isPlaying: () => true,
      subscribeToSessionChanges: () => () => {},
    },
  })

  visualizer.start()
  scheduler.tick()
  visualizer.dispose()

  const tracks = canvas.context.rects.filter((rect) => rect.style === TRACK_COLOR)
  const target = canvas.context.rects.find((rect) => rect.style === TARGET_COLOR)
  const tag = canvas.context.rects
    .filter((rect) => rect.style === LINE_COLOR)
    .sort((left, right) => right.width - left.width)[0]
  const readout = canvas.context.texts[canvas.context.texts.length - 1]

  assert.equal(tracks.length, 3)
  assert.ok(target)
  assert.ok(tag)
  assert.ok(readout)

  return { canvas, target, tag, tracks, readout }
}

function assertRectInsideCanvas(rect: DrawRect, canvas: FakeCanvas): void {
  assert.ok(rect.x >= 0, `rectangle starts before canvas: ${JSON.stringify(rect)}`)
  assert.ok(rect.y >= 0, `rectangle starts above canvas: ${JSON.stringify(rect)}`)
  assert.ok(rect.width > 0, `rectangle has non-positive width: ${JSON.stringify(rect)}`)
  assert.ok(rect.height > 0, `rectangle has non-positive height: ${JSON.stringify(rect)}`)
  assert.ok(rect.x + rect.width <= canvas.width, `rectangle exceeds canvas width: ${JSON.stringify(rect)}`)
  assert.ok(rect.y + rect.height <= canvas.height, `rectangle exceeds canvas height: ${JSON.stringify(rect)}`)
}

function cssRect(rect: DrawRect, pixelRatio: number): DrawRect {
  return {
    ...rect,
    x: rect.x / pixelRatio,
    y: rect.y / pixelRatio,
    width: rect.width / pixelRatio,
    height: rect.height / pixelRatio,
  }
}

test('wide LUFS canvases use a centered 240 CSS pixel viewport', () => {
  const result = renderMeter({ cssWidth: 522 })
  const [leftTrack, rightTrack, lufsTrack] = result.tracks
  const viewportLeft = (result.canvas.width - 240) / 2
  const viewportRight = viewportLeft + 240

  assert.equal(leftTrack.x, 174)
  assert.equal(leftTrack.width, rightTrack.width)
  assert.ok(
    Math.abs(lufsTrack.width - leftTrack.width * 2) <= 3,
    `expected 1:1:2 bars, received ${result.tracks.map((rect) => rect.width).join(':')}`,
  )

  for (const rect of result.canvas.context.rects) {
    assertRectInsideCanvas(rect, result.canvas)
    assert.ok(rect.x >= viewportLeft)
    assert.ok(rect.x + rect.width <= viewportRight)
  }

  assert.equal(result.target.x, leftTrack.x)
  assert.equal(result.target.x + result.target.width, lufsTrack.x + lufsTrack.width)
  assert.equal(result.readout.text, '-8.7LUFS')
})

test('minimum-width LUFS tiles keep every element in bounds and use compact readouts', () => {
  const result = renderMeter({ cssWidth: 112 })
  const [leftTrack, rightTrack, lufsTrack] = result.tracks

  assert.equal(leftTrack.width, 6)
  assert.equal(rightTrack.width, 6)
  assert.equal(lufsTrack.width, 12)
  assert.ok(leftTrack.x + leftTrack.width < rightTrack.x)
  assert.ok(rightTrack.x + rightTrack.width < lufsTrack.x)
  assert.ok(lufsTrack.x + lufsTrack.width <= result.tag.x)
  assert.equal(result.readout.text, '-8.7')

  for (const rect of result.canvas.context.rects) {
    assertRectInsideCanvas(rect, result.canvas)
  }

  for (const text of result.canvas.context.texts) {
    const textLeft = text.align === 'right' ? text.x - text.width : text.x
    const textRight = text.align === 'right' ? text.x : text.x + text.width
    assert.ok(textLeft >= 0, `text starts before canvas: ${JSON.stringify(text)}`)
    assert.ok(textRight <= result.canvas.width, `text exceeds canvas: ${JSON.stringify(text)}`)
  }
})

test('dropping the LUFS suffix does not redistribute readout space into the bars', () => {
  const compact = renderMeter({ cssWidth: 141 })
  const full = renderMeter({ cssWidth: 142 })

  assert.equal(compact.readout.text, '-8.7')
  assert.equal(full.readout.text, '-8.7LUFS')
  assert.deepEqual(
    compact.tracks.map((rect) => rect.width),
    full.tracks.map((rect) => rect.width),
  )
})

test('LUFS geometry remains equivalent across backing pixel ratios', () => {
  const baseline = renderMeter({ cssWidth: 522, pixelRatio: 1 })
  const baselineTracks = baseline.tracks.map((rect) => cssRect(rect, baseline.canvas.pixelRatio))
  const baselineTag = cssRect(baseline.tag, baseline.canvas.pixelRatio)
  const baselineTarget = cssRect(baseline.target, baseline.canvas.pixelRatio)

  for (const pixelRatio of [1.25, 2]) {
    const result = renderMeter({ cssWidth: 522, pixelRatio })
    const normalizedTracks = result.tracks.map((rect) => cssRect(rect, result.canvas.pixelRatio))
    const normalizedTag = cssRect(result.tag, result.canvas.pixelRatio)
    const normalizedTarget = cssRect(result.target, result.canvas.pixelRatio)

    for (let index = 0; index < baselineTracks.length; index += 1) {
      assert.ok(
        Math.abs(normalizedTracks[index].x - baselineTracks[index].x) <= 2,
        `track ${index} x differs at ${pixelRatio}x: ${normalizedTracks[index].x} vs ${baselineTracks[index].x}`,
      )
      assert.ok(
        Math.abs(normalizedTracks[index].width - baselineTracks[index].width) <= 2,
        `track ${index} width differs at ${pixelRatio}x: ${normalizedTracks[index].width} vs ${baselineTracks[index].width}`,
      )
    }
    assert.ok(Math.abs(normalizedTag.x - baselineTag.x) <= 2)
    assert.ok(Math.abs(normalizedTag.width - baselineTag.width) <= 2)
    assert.ok(Math.abs(normalizedTarget.x - baselineTarget.x) <= 2)
    assert.ok(
      Math.abs(normalizedTarget.width - baselineTarget.width) <= 3,
      `target width differs at ${pixelRatio}x: ${normalizedTarget.width} vs ${baselineTarget.width}`,
    )
  }
})

test('silent narrow meters keep the infinity readout visible and inside its tag', () => {
  const result = renderMeter({
    cssWidth: 112,
    snapshot: {
      ...ACTIVE_SNAPSHOT,
      momentaryLUFS: -60,
      shortTermLUFS: -60,
      integratedLUFS: -60,
    },
  })

  assert.equal(result.readout.text, '-∞')
  assert.ok(result.readout.x >= result.tag.x)
  assert.ok(result.readout.x + result.readout.width <= result.tag.x + result.tag.width)
  assertRectInsideCanvas(result.tag, result.canvas)
})
