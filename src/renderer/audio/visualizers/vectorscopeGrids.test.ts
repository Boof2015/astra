import { strict as assert } from 'node:assert'
import test from 'node:test'
import { drawVectorscopeGridForMode } from './vectorscopeGrids.ts'

test('vectorscope labels use their dedicated color without brightening grid lines', () => {
  const filledTexts: Array<{ text: string; style: string }> = []
  const strokeStyles: string[] = []
  let fillStyle = ''
  let strokeStyle = ''
  const context = {
    beginPath: () => undefined,
    fillText: (text: string) => filledTexts.push({ text, style: fillStyle }),
    lineTo: () => undefined,
    moveTo: () => undefined,
    setLineDash: () => undefined,
    stroke: () => strokeStyles.push(strokeStyle),
    strokeRect: () => strokeStyles.push(strokeStyle),
    get fillStyle() { return fillStyle },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) { fillStyle = String(value) },
    set font(_value: string) {},
    set lineWidth(_value: number) {},
    get strokeStyle() { return strokeStyle },
    set strokeStyle(value: string | CanvasGradient | CanvasPattern) { strokeStyle = String(value) },
    set textAlign(_value: CanvasTextAlign) {},
  } as unknown as CanvasRenderingContext2D

  const gridMajorColor = 'rgba(255, 255, 255, 0.12)'
  const gridMinorColor = 'rgba(255, 255, 255, 0.04)'
  const labelColor = '#9a9a9a'
  drawVectorscopeGridForMode(
    context,
    320,
    180,
    gridMajorColor,
    gridMinorColor,
    labelColor,
    'lissajous',
    1,
  )

  assert.deepEqual(filledTexts, [
    { text: 'L', style: labelColor },
    { text: 'R', style: labelColor },
  ])
  assert.ok(strokeStyles.includes(gridMajorColor))
  assert.ok(strokeStyles.includes(gridMinorColor))
  assert.ok(!strokeStyles.includes(labelColor))
})
