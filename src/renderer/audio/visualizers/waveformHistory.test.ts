import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import type { FrameScheduler } from './frameScheduler.ts'
import type { WaveformOptions } from './Waveform.ts'

// Record paint layers per pixel to check history order, erasure, and lane placement.
// Actual alpha blending and grid rendering are checked separately in Electron.
class RasterCanvas {
  private w = 1
  private h = 1
  pixels = ['']
  selfCopies = 0
  clearedPixels = 0
  get width() { return this.w }
  set width(value: number) { this.w = value; this.pixels = Array(this.w * this.h).fill('') }
  get height() { return this.h }
  set height(value: number) { this.h = value; this.pixels = Array(this.w * this.h).fill('') }
  readonly context = {
    fillStyle: '', imageSmoothingEnabled: false,
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    clearRect: (x: number, y: number, w: number, h: number) => {
      this.clearedPixels += w * h
      for (let row = y; row < y + h; row++) this.pixels.fill('', row * this.w + x, row * this.w + x + w)
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      for (let row = Math.max(0, y); row < Math.min(this.h, y + h); row++) {
        for (let col = Math.max(0, x); col < Math.min(this.w, x + w); col++) {
          this.pixels[row * this.w + col] += this.context.fillStyle + '|'
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
        const pixel = source[(sy + Math.floor(y * sh / dh)) * image.width + sx + Math.floor(x * sw / dw)]
        if (pixel) this.pixels[(dy + y) * this.w + dx + x] += pixel
      }
    },
  }
  getContext() { return this.context }
}

const savedGlobals = new Map(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
const canvases: RasterCanvas[] = []
Object.defineProperty(globalThis, 'window', { configurable: true, value: { devicePixelRatio: 1 } })
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  createElement: () => { const canvas = new RasterCanvas(); canvases.push(canvas); return canvas },
} })
after(() => {
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})
const { Waveform } = await import('./Waveform.ts')

const shapes = [[-1, 1], [0.8, 0.8], [0, 0], [-0.8, -0.8]]
function expectedColumn(shape: number, stereo: boolean, color = '255, 255, 255'): string[] {
  const fill = `rgba(${color}, 0.55)|`
  const edge = `rgba(${color}, 0.9)|`
  const lane = Array<string>(20).fill('')
  if (shape === 0) {
    lane.fill(fill, 1, 20)
    lane[1] += edge; lane[19] += edge
  } else {
    lane[[0, 2, 10, 18][shape]] = fill + edge
  }
  if (!stereo) return lane
  const rightShape = shape === 1 ? 3 : shape === 3 ? 1 : shape
  return [...lane, ...expectedColumn(rightShape, false, color)]
}

function fixture(stereo = false, fallback = false, width = 7) {
  const canvas = new RasterCanvas()
  canvas.width = width; canvas.height = stereo ? 40 : 20
  const callbacks = new Set<() => void>()
  const pending: Array<{ left: Float32Array; right: Float32Array }> = []
  let playing = true, unsubscribed = false
  let sessionChange = () => {}
  const summarize = (left: Float32Array, right?: Float32Array) => {
    const values: number[] = []
    for (let i = 0; i < left.length; i += 2) {
      values.push(left[i], left[i + 1], 0, 0, 0)
      if (right) values.push(right[i], right[i + 1], 0, 0, 0)
    }
    return Float32Array.from(values)
  }
  const firstCanvas = canvases.length
  const scope = new Waveform(canvas as unknown as HTMLCanvasElement, {
    mode: stereo ? 'stereo' : 'mono', lineColor: '#ffffff', backgroundColor: 'transparent',
    frameScheduler: { subscribe: (callback: () => void) => {
      callbacks.add(callback); return () => callbacks.delete(callback)
    } } as unknown as FrameScheduler,
    dataSource: {
      isPlaying: () => playing, getSampleRate: () => 256, // Two samples per column.
      getPendingWaveformSamples: () => pending.splice(0).map(chunk => chunk.left),
      getPendingWaveformStereoSamples: () => pending.splice(0),
      subscribeToSessionChanges: callback => { sessionChange = callback; return () => { unsubscribed = true } },
    },
    nativeAnalyzer: fallback ? null : {
      isAvailable: () => true, configure() {}, reset() {},
      processMono: samples => summarize(samples), processStereo: (left, right) => summarize(left, right),
    },
  })
  const historyCanvas = canvases[firstCanvas]
  const tick = () => { for (const callback of [...callbacks]) callback() }
  scope.start()
  return {
    canvas, scope, tick, historyCanvas, reset: () => sessionChange(),
    feed(values: number[]) {
      pending.push({
        left: Float32Array.from(values.flatMap(shape => shapes[shape])),
        right: Float32Array.from(values.flatMap(shape => [-shapes[shape][1], -shapes[shape][0]])),
      })
      tick()
    },
    pause(value: boolean) { playing = !value; scope.invalidate(); tick() },
    expect(columns: string[][]) {
      const expected = Array.from({ length: canvas.height }, (_, y) => columns.map(column => column[y])).flat()
      assert.deepEqual(canvas.pixels, expected)
    },
    dispose() { scope.dispose(); assert.equal(callbacks.size, 0); assert.equal(unsubscribed, true) },
  }
}

for (const stereo of [false, true]) for (const fallback of [false, true]) {
  test(`${stereo ? 'stereo' : 'mono'} ${fallback ? 'fallback' : 'native'} history matches a linear queue through wrap, overflow, and erasure`, () => {
    const f = fixture(stereo, fallback)
    let history = Array.from({ length: 7 }, () => Array<string>(f.canvas.height).fill(''))
    let next = 0
    try {
      for (const count of [0, 1, 3, 4, 2, 7, 1, 19, 6, 8, 3, 0, 5, 14, 1]) {
        const values = Array.from({ length: count }, () => next++ % shapes.length)
        history = [...history, ...values.map(shape => expectedColumn(shape, stereo))].slice(-7)
        f.feed(values); f.expect(history)
      }
      assert.equal(f.historyCanvas.selfCopies, 0)
      const before = f.historyCanvas.clearedPixels
      f.feed([2])
      assert.equal(f.historyCanvas.clearedPixels - before, f.canvas.height, 'one new column only clears one column of history')
    } finally { f.dispose() }
  })
}

test('paused resizing keeps the newest history at the right edge; resume, color change, and reset retain order', () => {
  const f = fixture()
  const blank = () => Array<string>(20).fill('')
  try {
    f.feed([0, 1, 2, 3, 0, 1, 2, 3, 0])
    f.pause(true)
    f.canvas.width = 10; f.scope.resize(); f.tick()
    f.expect([...Array.from({ length: 3 }, blank), ...[2, 3, 0, 1, 2, 3, 0].map(shape => expectedColumn(shape, false))])
    f.canvas.width = 4; f.scope.resize(); f.tick()
    f.expect([1, 2, 3, 0].map(shape => expectedColumn(shape, false)))
    f.pause(false); f.scope.setOptions({ lineColor: '#112233' }); f.feed([2])
    f.expect([...[2, 3, 0].map(shape => expectedColumn(shape, false)), expectedColumn(2, false, '17, 34, 51')])
    f.reset(); f.tick(); f.expect(Array.from({ length: 4 }, blank))
    f.feed([1]); f.expect([blank(), blank(), blank(), expectedColumn(1, false, '17, 34, 51')])
  } finally { f.dispose() }
})

for (const options of [{ mode: 'stereo' }, { multiband: true }, { scrollSpeed: 2 }] satisfies Partial<WaveformOptions>[]) {
  test(`changing ${Object.keys(options)[0]} clears wrapped history`, () => {
    const f = fixture()
    try {
      f.feed([0, 1, 2, 3, 0, 1, 2, 3, 0])
      f.scope.setOptions(options); f.tick()
      assert.ok(f.canvas.pixels.every(pixel => pixel === ''))
    } finally { f.dispose() }
  })
}

test('an initially zero-width canvas can grow and accept a new history', () => {
  const f = fixture(false, false, 0)
  try {
    f.tick(); f.canvas.width = 3; f.scope.resize(); f.feed([1])
    f.expect([Array(20).fill(''), Array(20).fill(''), expectedColumn(1, false)])
  } finally { f.dispose() }
})
