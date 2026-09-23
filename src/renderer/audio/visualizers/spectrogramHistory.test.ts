import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import type { FrameScheduler } from './frameScheduler.ts'
import type { SpectrogramNativeResult } from '../native/index.ts'
import type { SpectrogramOptions } from './Spectrogram.ts'

// Small raster double for checking column order and dirty rectangles. Real browser
// comparisons cover Canvas premultiplication, grids, and resampling separately.
let imageAllocations = 0
class TestImageData {
  readonly data: Uint8ClampedArray
  readonly width: number
  readonly height: number
  constructor(width: number, height: number) {
    assert.ok(width > 0 && height > 0)
    this.width = width
    this.height = height
    this.data = new Uint8ClampedArray(width * height * 4)
    imageAllocations++
  }
}

class RasterCanvas {
  private w = 1
  private h = 1
  pixels = new Uint32Array(1)
  uploads = 0
  selfCopies = 0
  uploadCapacity = 0
  get width() { return this.w }
  set width(value: number) { this.w = value; this.pixels = new Uint32Array(this.w * this.h) }
  get height() { return this.h }
  set height(value: number) { this.h = value; this.pixels = new Uint32Array(this.w * this.h) }
  readonly context = {
    imageSmoothingEnabled: false,
    clearRect: (x: number, y: number, w: number, h: number) => {
      for (let row = y; row < y + h; row++) this.pixels.fill(0, row * this.w + x, row * this.w + x + w)
    },
    putImageData: (image: TestImageData, dx: number, dy: number,
      sx = 0, sy = 0, sw = image.width, sh = image.height) => {
      this.uploads++
      this.uploadCapacity = Math.max(this.uploadCapacity, image.width * image.height)
      const source = new Uint32Array(image.data.buffer)
      for (let y = sy; y < sy + sh; y++) for (let x = sx; x < sx + sw; x++) {
        if (dx + x >= 0 && dx + x < this.w && dy + y >= 0 && dy + y < this.h) {
          this.pixels[(dy + y) * this.w + dx + x] = source[y * image.width + x]
        }
      }
    },
    drawImage: (image: RasterCanvas, ...args: number[]) => {
      if (image === this) this.selfCopies++
      const [sx, sy, sw, sh, dx, dy, dw, dh] = args.length === 2
        ? [0, 0, image.width, image.height, args[0], args[1], image.width, image.height]
        : args
      const source = image.pixels.slice()
      for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
        this.pixels[(dy + y) * this.w + dx + x] = source[(sy + Math.floor(y * sh / dh)) * image.width + sx + Math.floor(x * sw / dw)]
      }
    },
  }
  getContext() { return this.context }
}

const savedGlobals = new Map(['window', 'document', 'ImageData'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
const canvases: RasterCanvas[] = []
Object.defineProperty(globalThis, 'window', { configurable: true, value: { devicePixelRatio: 1 } })
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  createElement: () => { const canvas = new RasterCanvas(); canvases.push(canvas); return canvas },
} })
Object.defineProperty(globalThis, 'ImageData', { configurable: true, value: TestImageData })
after(() => {
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})
const { Spectrogram } = await import('./Spectrogram.ts')

function rgba(r: number, g: number, b: number, alpha: number): number {
  return new Uint32Array(Uint8ClampedArray.of(r, g, b, alpha).buffer)[0]
}

function fixture(vertical: boolean, span = 7, rows = 3, options: Partial<SpectrogramOptions> = {}) {
  const canvas = new RasterCanvas()
  canvas.width = vertical ? rows : span
  canvas.height = vertical ? span : rows
  const callbacks = new Set<() => void>()
  const results: SpectrogramNativeResult[] = []
  const pending: Float32Array[] = []
  let playing = true
  let sessionChange = () => {}
  let unsubscribed = false
  const scope = new Spectrogram(canvas as unknown as HTMLCanvasElement, {
    orientation: vertical ? 'vertical' : 'horizontal', showGrid: false, backgroundColor: 'transparent',
    colorScheme: 'mono', lineColor: '#ffffff', ...options,
    frameScheduler: { subscribe: (callback: () => void) => {
      callbacks.add(callback); return () => callbacks.delete(callback)
    } } as unknown as FrameScheduler,
    dataSource: {
      isPlaying: () => playing, getSampleRate: () => 48000,
      getPendingSpectrogramSamples: () => pending.splice(0),
      subscribeToSessionChanges: callback => { sessionChange = callback; return () => { unsubscribed = true } },
    },
    nativeAnalyzer: {
      isAvailable: () => true, configure: () => {},
      reset: () => { results.length = 0; pending.length = 0 },
      process: () => results.shift() ?? null,
    },
  })
  const tick = () => { for (const callback of [...callbacks]) callback() }
  scope.start()
  return {
    scope, canvas, tick, reset: () => sessionChange(),
    pause(value: boolean) { playing = !value; scope.invalidate(); tick() },
    feed(values: number[], heat = 1, rowStep = 0) {
      const display = Float32Array.from(values.flatMap(value => Array.from({ length: rows }, (_, row) => (value + row * rowStep) / 255)))
      results.push({ display, heat: new Float32Array(display.length).fill(heat), rowCount: rows, columnCount: values.length })
      pending.push(Float32Array.of(0))
      tick()
    },
    expect(columns: number[][]) {
      const expected: number[] = []
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        expected.push(columns[vertical ? y : x][vertical ? x : y])
      }
      assert.deepEqual(Array.from(canvas.pixels), expected)
    },
    dispose() { scope.dispose(); assert.equal(callbacks.size, 0); assert.equal(unsubscribed, true) },
  }
}

for (const vertical of [false, true]) {
  const orientation = vertical ? 'vertical' : 'horizontal'
  test(`${orientation}: arbitrary batch sizes match a linear history, including repeated wrap and overflow`, () => {
    const f = fixture(vertical)
    let history = Array.from({ length: 7 }, () => [0, 0, 0])
    let next = 1
    try {
      for (const count of [0, 1, 3, 4, 2, 7, 1, 19, 6, 8, 3, 0, 5, 14, 1]) {
        const values = Array.from({ length: count }, () => next++ % 254 + 1)
        history = [...history, ...values.map(alpha => Array(3).fill(rgba(255, 255, 255, alpha)))].slice(-7)
        f.feed(values)
        f.expect(history)
      }
      const historyCanvas = canvases.slice().reverse().find(canvas => canvas.uploads > 0)!
      assert.equal(historyCanvas.selfCopies, 0, 'appending history must not scroll/copy its existing surface')
      assert.ok(historyCanvas.uploadCapacity <= 7 * 3, 'scratch allocation is bounded by the history dimensions')
    } finally { f.dispose() }
  })

  test(`${orientation}: growing and shrinking paused history anchors its newest edge, and reset clears wrapped history`, () => {
    const f = fixture(vertical)
    const column = (alpha: number) => Array(3).fill(rgba(255, 255, 255, alpha))
    try {
      f.feed([1, 2, 3, 4, 5, 6, 7, 8, 9])
      f.pause(true)
      if (vertical) f.canvas.height = 10
      else f.canvas.width = 10
      f.scope.resize(); f.tick()
      f.expect([...Array.from({ length: 3 }, () => [0, 0, 0]), ...[3, 4, 5, 6, 7, 8, 9].map(column)])
      if (vertical) f.canvas.height = 4
      else f.canvas.width = 4
      f.scope.resize(); f.tick()
      f.expect([6, 7, 8, 9].map(column))
      f.pause(false); f.feed([10, 11])
      f.expect([8, 9, 10, 11].map(column))
      f.reset(); f.tick()
      f.expect(Array.from({ length: 4 }, () => [0, 0, 0]))
      f.feed([12]); f.expect([[0, 0, 0], [0, 0, 0], [0, 0, 0], column(12)])
    } finally { f.dispose() }
  })

  test(`${orientation}: frequency rows keep their order across strip uploads and wraparound`, () => {
    const f = fixture(vertical, 4)
    try {
      f.feed([1, 2, 3], 1, 20)
      f.feed([4, 5, 6], 1, 20)
      f.expect([3, 4, 5, 6].map(value => [value, value + 20, value + 40].map(alpha => rgba(255, 255, 255, alpha))))
    } finally { f.dispose() }
  })
}

test('strip capacity is reused for alternating batch sizes without uploading stale pixels', () => {
  const f = fixture(false, 17)
  try {
    f.feed([5, 6, 7, 8])
    const before = imageAllocations
    for (let i = 0; i < 50; i++) f.feed(i % 2 ? [1, 2, 3] : [1, 2, 3, 4])
    assert.equal(imageAllocations, before)
    f.reset(); f.tick(); f.feed([42])
    f.expect([...Array.from({ length: 16 }, () => [0, 0, 0]), Array(3).fill(rgba(255, 255, 255, 42))])
  } finally { f.dispose() }
})

test('color and palette changes affect new columns while retaining the existing history and alpha rounding', () => {
  const f = fixture(false, 4, 1, { lineColor: 'rgba(24.5, 39.5, 200, 0.6)' })
  try {
    f.feed([128])
    f.scope.setOptions({ colorScheme: 'heat', heatColors: ['#112233', '#445566', '#789abc80'] })
    f.feed([255, 128])
    f.scope.setOptions({ colorScheme: 'mono', lineColor: '#456789' })
    f.feed([64])
    f.expect([
      [rgba(25, 40, 200, 77)], [rgba(120, 154, 188, 128)],
      [rgba(120, 154, 188, 64)], [rgba(69, 103, 137, 64)],
    ])
  } finally { f.dispose() }
})

test('orientation changes discard the old ring and restart at the new bottom edge', () => {
  const f = fixture(false)
  try {
    f.feed([1, 2, 3, 4, 5, 6, 7, 8, 9])
    f.canvas.width = 3; f.canvas.height = 7
    f.scope.setOptions({ orientation: 'vertical' }); f.tick()
    assert.deepEqual(Array.from(f.canvas.pixels), Array(21).fill(0))
    f.feed([200])
    assert.deepEqual(Array.from(f.canvas.pixels), [...Array(18).fill(0), ...Array(3).fill(rgba(255, 255, 255, 200))])
  } finally { f.dispose() }
})

test('zero-sized canvases can grow safely', () => {
  const f = fixture(false, 0, 0)
  try {
    f.tick()
    f.canvas.width = 3; f.canvas.height = 2
    f.scope.resize(); f.tick()
    assert.deepEqual(Array.from(f.canvas.pixels), Array(6).fill(0))
    f.scope.setOptions({ orientation: 'vertical' }); f.tick()
    assert.deepEqual(Array.from(f.canvas.pixels), Array(6).fill(0))
  } finally { f.dispose() }
})
