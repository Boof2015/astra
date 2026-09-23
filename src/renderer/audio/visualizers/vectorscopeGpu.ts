import { parseColorToRgba } from '../../utils/color'

export type VectorscopePointContext = Pick<CanvasRenderingContext2D, 'fillStyle' | 'globalAlpha' | 'fillRect'>

// Keep every rectangle as a separate primitive, in its original order. Combining
// overlapping dots into a Canvas path would discard their accumulated opacity.
const POINT_VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec4 rectangle;
layout(location=1) in vec4 color;
uniform vec2 size;
flat out vec4 bounds;
flat out vec4 tint;
void main() {
  vec2 corners[6] = vec2[6](vec2(0,0), vec2(1,0), vec2(0,1), vec2(0,1), vec2(1,0), vec2(1,1));
  vec2 pixel = mix(floor(rectangle.xy), ceil(rectangle.xy + rectangle.zw), corners[gl_VertexID]);
  gl_Position = vec4(pixel / size * vec2(2,-2) + vec2(-1,1), 0, 1);
  bounds = rectangle;
  tint = color;
}`

const POINT_FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 size;
uniform int coverageMode;
flat in vec4 bounds;
flat in vec4 tint;
out vec4 result;
void main() {
  vec2 pixel = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y);
  vec2 edges = max(vec2(0), min(bounds.xy + bounds.zw, pixel + 0.5) - max(bounds.xy, pixel - 0.5));
  float coverage;
  if (coverageMode == 0) {
    coverage = edges.x * edges.y;
  } else {
    coverage = min(edges.x, edges.y);
    if (coverageMode == 2) {
      vec2 outside = max(vec2(0), vec2(0.5) - edges);
      coverage = max(0.0, coverage - 0.41421356237 * min(outside.x, outside.y));
    }
  }
  float alpha = tint.a * coverage;
  result = vec4(tint.rgb * alpha, alpha);
}`

const FADE_VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0, 1);
}`
const FADE_FRAGMENT = `#version 300 es
precision highp float;
out vec4 result;
void main() { result = vec4(0); }
`

// Canvas backends use different corner coverage. Probe a separate tiny surface
// once, without reading back the live history or changing its acceleration.
// 0: area coverage; 1: intersecting edge ramps; 2: bevelled outer AA corners.
export function detectVectorscopeCoverage(ctx: CanvasRenderingContext2D): number | null {
  ctx.clearRect(0, 0, 8, 8)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(2.2, 2.3, 3, 3)
  const pixels = ctx.getImageData(0, 0, 8, 8).data
  const upper = pixels[(2 * 8 + 2) * 4 + 3]
  const lower = pixels[(5 * 8 + 5) * 4 + 3]
  if (Math.abs(upper - 143) <= 3 && Math.abs(lower - 15) <= 3) return 0
  if (Math.abs(upper - 178) <= 3 && Math.abs(lower - 51) <= 3) return 1
  if (Math.abs(upper - 178) <= 3 && Math.abs(lower - 30) <= 3) return 2
  return null
}

export class VectorscopeGpuRenderer implements VectorscopePointContext {
  readonly canvas: HTMLCanvasElement
  private readonly gl: WebGL2RenderingContext
  private readonly colorContext: CanvasRenderingContext2D
  globalAlpha = 1
  private style: string | CanvasGradient | CanvasPattern = '#000000'
  private tint = [0, 0, 0, 1]
  private colors = new Map<string, number[]>()
  private points = new Float32Array(4096 * 3 * 8)
  private count = 0
  private available = true
  private disposed = false
  private pointProgram: WebGLProgram
  private fadeProgram: WebGLProgram
  private buffer: WebGLBuffer
  private vao: WebGLVertexArrayObject
  private sizeUniform: WebGLUniformLocation | null
  private maxSize: Int32Array

  constructor(
    canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    colorContext: CanvasRenderingContext2D,
    coverageMode: number,
  ) {
    this.canvas = canvas
    this.gl = gl
    this.colorContext = colorContext
    this.pointProgram = this.createProgram(POINT_VERTEX, POINT_FRAGMENT)
    this.fadeProgram = this.createProgram(FADE_VERTEX, FADE_FRAGMENT)
    this.sizeUniform = gl.getUniformLocation(this.pointProgram, 'size')
    this.maxSize = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
    this.buffer = gl.createBuffer()!
    this.vao = gl.createVertexArray()!
    if (!this.buffer || !this.vao) throw new Error('Could not allocate vectorscope buffers')
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.points.byteLength, gl.DYNAMIC_DRAW)
    for (let attribute = 0; attribute < 2; attribute++) {
      gl.enableVertexAttribArray(attribute)
      gl.vertexAttribPointer(attribute, 4, gl.FLOAT, false, 32, attribute * 16)
      gl.vertexAttribDivisor(attribute, 1)
    }
    gl.bindVertexArray(null)
    gl.useProgram(this.pointProgram)
    gl.uniform1i(gl.getUniformLocation(this.pointProgram, 'coverageMode'), coverageMode)
    gl.disable(gl.DITHER)
    gl.enable(gl.BLEND)
    canvas.addEventListener('webglcontextlost', this.onContextLost)
  }

  private onContextLost = (): void => {
    // The owning scope switches to its existing Canvas renderer on the next
    // frame. Do not repeatedly recreate a failing GPU context.
    this.available = false
  }

  private createProgram(vertexSource: string, fragmentSource: string): WebGLProgram {
    const gl = this.gl
    const shaders: WebGLShader[] = []
    const program = gl.createProgram()
    if (!program) throw new Error('Could not allocate vectorscope program')
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]] as const) {
        const shader = gl.createShader(type)
        if (!shader) throw new Error('Could not allocate vectorscope shader')
        shaders.push(shader)
        gl.shaderSource(shader, source)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Could not compile vectorscope shader')
        gl.attachShader(program, shader)
      }
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Could not link vectorscope program')
      return program
    } catch (error) {
      gl.deleteProgram(program)
      throw error
    } finally {
      for (const shader of shaders) gl.deleteShader(shader)
    }
  }

  setPalette(colors: readonly string[]): boolean {
    this.colors.clear()
    for (const color of colors) {
      // Let Canvas normalize named/HSL colors; unsupported color spaces keep
      // using Canvas rather than approximating their conversion in the shader.
      this.colorContext.fillStyle = '#010203'
      this.colorContext.fillStyle = color
      if (this.colorContext.fillStyle === '#010203') {
        this.colorContext.fillStyle = '#040506'
        this.colorContext.fillStyle = color
        if (this.colorContext.fillStyle === '#040506') return false
      }
      const parsed = parseColorToRgba(this.colorContext.fillStyle as string)
      if (!parsed) return false
      this.colors.set(color, [parsed.r / 255, parsed.g / 255, parsed.b / 255, parsed.a])
    }
    return true
  }

  get fillStyle(): string | CanvasGradient | CanvasPattern { return this.style }
  set fillStyle(value: string | CanvasGradient | CanvasPattern) {
    this.style = value
    if (typeof value === 'string') this.tint = this.colors.get(value) ?? this.tint
  }

  beginFrame(width: number, height: number, persistence: number, dotSize: number): boolean {
    if (!this.available || this.disposed || this.gl.isContextLost()
      || width > this.maxSize[0] || height > this.maxSize[1]
      || !Number.isFinite(dotSize) || Math.abs(dotSize) < 1
      || !Number.isFinite(persistence) || persistence < 0 || persistence > 1) return false
    const gl = this.gl
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
      gl.viewport(0, 0, width, height)
    }
    this.count = 0
    gl.bindVertexArray(null)
    gl.useProgram(this.fadeProgram)
    // CSS rgba() stores its alpha in an 8-bit color before destination-in.
    gl.blendColor(0, 0, 0, Math.round(persistence * 255) / 255)
    gl.blendFunc(gl.ZERO, gl.CONSTANT_ALPHA)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    return true
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    if (width < 0) { x += width; width = -width }
    if (height < 0) { y += height; height = -height }
    if (this.count * 8 === this.points.length) {
      const grown = new Float32Array(this.points.length * 2)
      grown.set(this.points)
      this.points = grown
    }
    const offset = this.count++ * 8
    this.points[offset] = x
    this.points[offset + 1] = y
    this.points[offset + 2] = width
    this.points[offset + 3] = height
    this.points[offset + 4] = this.tint[0]
    this.points[offset + 5] = this.tint[1]
    this.points[offset + 6] = this.tint[2]
    this.points[offset + 7] = this.tint[3] * this.globalAlpha
  }

  present(ctx: CanvasRenderingContext2D): void {
    const gl = this.gl
    if (this.count > 0) {
      gl.bindVertexArray(this.vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
      // Allow the driver to retire the previous frame's storage instead of
      // synchronizing this upload against a draw that still reads it.
      gl.bufferData(gl.ARRAY_BUFFER, this.points.byteLength, gl.STREAM_DRAW)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.points, 0, this.count * 8)
      gl.useProgram(this.pointProgram)
      gl.uniform2f(this.sizeUniform, this.canvas.width, this.canvas.height)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count)
    }
    this.count = 0
    ctx.drawImage(this.canvas, 0, 0)
  }

  clear(): void {
    this.count = 0
    this.gl.clearColor(0, 0, 0, 0)
    this.gl.clear(this.gl.COLOR_BUFFER_BIT)
  }

  copyHistoryTo(ctx: CanvasRenderingContext2D): void {
    if (this.available && !this.gl.isContextLost()
      && ctx.canvas.width === this.canvas.width && ctx.canvas.height === this.canvas.height) {
      ctx.drawImage(this.canvas, 0, 0)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost)
    const gl = this.gl
    gl.deleteBuffer(this.buffer)
    gl.deleteVertexArray(this.vao)
    gl.deleteProgram(this.pointProgram)
    gl.deleteProgram(this.fadeProgram)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

export function createVectorscopeGpuRenderer(colors: readonly string[]): VectorscopeGpuRenderer | null {
  let gl: WebGL2RenderingContext | null = null
  try {
    const probe = document.createElement('canvas')
    probe.width = probe.height = 8
    const colorContext = probe.getContext('2d')
    if (!colorContext) return null
    const coverageMode = detectVectorscopeCoverage(colorContext)
    if (coverageMode === null) return null
    const canvas = document.createElement('canvas')
    gl = canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: true, failIfMajorPerformanceCaveat: true, powerPreference: 'low-power',
    })
    if (!gl) return null
    const renderer = new VectorscopeGpuRenderer(canvas, gl, colorContext, coverageMode)
    if (!renderer.setPalette(colors)) { renderer.dispose(); return null }
    return renderer
  } catch {
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return null
  }
}
