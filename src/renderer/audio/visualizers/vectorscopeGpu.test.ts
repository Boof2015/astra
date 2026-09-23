import assert from 'node:assert/strict'
import test from 'node:test'
import { createVectorscopeGpuRenderer, detectVectorscopeCoverage, VectorscopeGpuRenderer } from './vectorscopeGpu.ts'

function colorContext(upper = 178, lower = 30): CanvasRenderingContext2D {
  const pixels = new Uint8ClampedArray(8 * 8 * 4)
  pixels[(2 * 8 + 2) * 4 + 3] = upper
  pixels[(5 * 8 + 5) * 4 + 3] = lower
  return {
    fillStyle: '#ffffff', clearRect() {}, fillRect() {},
    getImageData: () => ({ data: pixels }),
  } as unknown as CanvasRenderingContext2D
}

function fixture(compile = true) {
  const canvas = Object.assign(new EventTarget(), { width: 1, height: 1 }) as unknown as HTMLCanvasElement
  const uploads: Float32Array[] = []
  const uploadSources: Float32Array[] = []
  const draws: number[] = []
  const allocations: number[] = []
  const blends: number[][] = []
  let lost = false, deleted = 0, presented = 0, fades = 0
  const context = {
    ARRAY_BUFFER: 1, DYNAMIC_DRAW: 2, VERTEX_SHADER: 3, FRAGMENT_SHADER: 4,
    COMPILE_STATUS: 5, LINK_STATUS: 6, MAX_VIEWPORT_DIMS: 7, FLOAT: 8,
    DITHER: 9, BLEND: 10, ZERO: 11, CONSTANT_ALPHA: 12,
    TRIANGLES: 13, ONE: 14, ONE_MINUS_SRC_ALPHA: 15, COLOR_BUFFER_BIT: 16, STREAM_DRAW: 17,
    createShader: () => ({}), shaderSource() {}, compileShader() {},
    getShaderParameter: () => compile, attachShader() {}, linkProgram() {},
    getProgramParameter: () => true, createProgram: () => ({}), deleteShader() {},
    getUniformLocation: () => ({}), getParameter: () => Int32Array.of(2048, 2048),
    createBuffer: () => ({}), createVertexArray: () => ({}),
    bindVertexArray() {}, bindBuffer() {}, enableVertexAttribArray() {},
    vertexAttribPointer() {}, vertexAttribDivisor() {}, useProgram() {},
    uniform1i() {}, uniform2f() {}, disable() {}, enable() {}, viewport() {},
    isContextLost: () => lost,
    bufferData: (_target: number, bytes: number) => allocations.push(bytes),
    bufferSubData: (_target: number, _offset: number, data: Float32Array, start: number, length: number) => {
      uploadSources.push(data)
      uploads.push(data.slice(start, start + length))
    },
    blendColor() {}, blendFunc: (source: number, destination: number) => blends.push([source, destination]),
    drawArrays: () => { fades++ },
    drawArraysInstanced: (_mode: number, _first: number, vertices: number, instances: number) => {
      assert.equal(vertices, 6); draws.push(instances)
    },
    clearColor() {}, clear() {},
    deleteBuffer: () => { deleted++ }, deleteVertexArray: () => { deleted++ }, deleteProgram: () => { deleted++ },
    getExtension: () => ({ loseContext: () => { lost = true } }),
  }
  const gl = context as unknown as WebGL2RenderingContext
  const output = {
    canvas: { width: 100, height: 60 },
    drawImage: (source: HTMLCanvasElement) => { assert.equal(source, canvas); presented++ },
  } as unknown as CanvasRenderingContext2D
  return {
    canvas, gl, output, uploads, uploadSources, draws, allocations, blends,
    renderer: () => new VectorscopeGpuRenderer(canvas, gl, colorContext(), 2),
    loss: () => { lost = true; canvas.dispatchEvent(new Event('webglcontextlost')) },
    stats: () => ({ lost, deleted, presented, fades }),
  }
}

test('coverage calibration recognizes known Canvas edge rules and rejects unfamiliar output', () => {
  assert.equal(detectVectorscopeCoverage(colorContext(143, 15)), 0)
  assert.equal(detectVectorscopeCoverage(colorContext(178, 51)), 1)
  assert.equal(detectVectorscopeCoverage(colorContext(178, 30)), 2)
  assert.equal(detectVectorscopeCoverage(colorContext(0, 0)), null)
})

test('overlapping rectangles retain submission order, individual color, and alpha in one batch', () => {
  const f = fixture(), renderer = f.renderer()
  try {
    assert.equal(renderer.setPalette(['#ff0000', '#0000ff80']), true)
    assert.equal(renderer.beginFrame(100, 60, 0.1, 3), true)
    renderer.fillStyle = '#ff0000'; renderer.globalAlpha = 0.25
    renderer.fillRect(2.25, 4.5, 3, 3)
    renderer.fillStyle = '#0000ff80'; renderer.globalAlpha = 0.75
    renderer.fillRect(2.25, 4.5, 3, 3)
    renderer.fillStyle = '#ff0000'; renderer.globalAlpha = 1
    renderer.fillRect(2.25, 4.5, 3, 3)
    renderer.present(f.output)
    assert.deepEqual(f.draws, [3])
    assert.equal(f.uploads.length, 1)
    assert.deepEqual(Array.from(f.uploads[0]), Array.from(Float32Array.of(
      2.25, 4.5, 3, 3, 1, 0, 0, 0.25,
      2.25, 4.5, 3, 3, 0, 0, 1, 128 / 255 * 0.75,
      2.25, 4.5, 3, 3, 1, 0, 0, 1,
    )))
    assert.deepEqual(f.blends, [[f.gl.ZERO, f.gl.CONSTANT_ALPHA], [f.gl.ONE, f.gl.ONE_MINUS_SRC_ALPHA]])
    renderer.beginFrame(100, 60, 0.1, 3); renderer.present(f.output)
    assert.deepEqual(f.draws, [3], 'empty frames must not replay the previous batch')
    assert.equal(f.stats().fades, 2)
    assert.equal(f.stats().presented, 2)
  } finally { renderer.dispose() }
})

test('large point batches grow reusable storage without dropping points or uploading stale capacity', () => {
  const f = fixture(), renderer = f.renderer()
  try {
    renderer.setPalette(['#ffffff']); renderer.fillStyle = '#ffffff'
    renderer.beginFrame(100, 60, 0.1, 3)
    for (let i = 0; i < 12289; i++) renderer.fillRect(i % 100, 20, 3, 3)
    renderer.present(f.output)
    assert.deepEqual(f.draws, [12289])
    assert.equal(f.uploads[0].length, 12289 * 8)
    assert.equal(f.allocations.length, 2)
    renderer.beginFrame(100, 60, 0.1, 3)
    renderer.fillRect(12, 20, 3, 3); renderer.present(f.output)
    assert.equal(f.allocations.length, 3, 'each upload orphans the GPU storage used by the preceding frame')
    assert.equal(f.uploadSources[0], f.uploadSources[1], 'the CPU point array is reused')
    assert.equal(f.allocations[1], f.allocations[2])
    assert.equal(f.uploads[1].length, 8)
  } finally { renderer.dispose() }
})

test('reset discards queued dots; valid history can transfer to Canvas before a renderer change', () => {
  const f = fixture(), renderer = f.renderer()
  try {
    renderer.beginFrame(100, 60, 0.1, 3)
    renderer.fillRect(1, 1, 3, 3); renderer.clear(); renderer.present(f.output)
    assert.equal(f.draws.length, 0)
    renderer.copyHistoryTo(f.output)
    assert.equal(f.stats().presented, 2)
    f.output.canvas.width = 101
    renderer.copyHistoryTo(f.output)
    assert.equal(f.stats().presented, 2, 'resizing clears the old history rather than copying incompatible dimensions')
  } finally { renderer.dispose() }
})

test('context loss and unsupported dimensions request fallback, and disposal releases resources once', () => {
  const f = fixture(), renderer = f.renderer()
  assert.equal(renderer.beginFrame(4096, 60, 0.1, 3), false)
  assert.equal(renderer.beginFrame(100, 60, 0.1, 0.8), false)
  assert.equal(renderer.beginFrame(100, 60, 0.1, 3), true)
  f.loss()
  assert.equal(renderer.beginFrame(100, 60, 0.1, 3), false)
  renderer.copyHistoryTo(f.output)
  assert.equal(f.stats().presented, 0)
  renderer.dispose(); renderer.dispose()
  assert.equal(f.stats().deleted, 4)
})

test('factory returns Canvas fallback on unknown coverage, unavailable GPU, or shader failure', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document')
  try {
    for (const kind of ['coverage', 'unavailable', 'shader']) {
      const f = fixture(false)
      Object.defineProperty(globalThis, 'document', { configurable: true, value: {
        createElement: () => ({
          getContext: (type: string) => type === '2d'
            ? colorContext(kind === 'coverage' ? 0 : 178, kind === 'coverage' ? 0 : 30)
            : kind === 'unavailable' ? null : f.gl,
        }),
      } })
      assert.equal(createVectorscopeGpuRenderer(['#ffffff']), null)
      if (kind === 'shader') assert.equal(f.stats().lost, true)
    }
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})
