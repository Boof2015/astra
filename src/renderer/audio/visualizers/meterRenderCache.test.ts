import { strict as assert } from 'node:assert'
import test from 'node:test'
import { MeterRenderCache } from './meterRenderCache.ts'

function createFixture() {
  const fonts = new EventTarget()
  const cache = new MeterRenderCache({ ownerDocument: { fonts } } as unknown as HTMLCanvasElement)
  let measurements = 0
  let glyphWidth = 6
  const ctx = {
    font: '10px monospace',
    measureText(text: string) {
      measurements += 1
      return { width: text.length * glyphWidth }
    },
  } as CanvasRenderingContext2D
  return { cache, ctx, fonts, measurements: () => measurements, setGlyphWidth: (width: number) => { glyphWidth = width } }
}

test('meter widths follow font changes and fonts completing or failing to load', () => {
  const { cache, ctx, fonts, measurements, setGlyphWidth } = createFixture()
  assert.equal(cache.textWidth(ctx, '-14.0LUFS', ctx.font), 54)
  assert.equal(cache.textWidth(ctx, '-14.0LUFS', ctx.font), 54)
  assert.equal(measurements(), 1)

  ctx.font = '20px monospace'
  setGlyphWidth(12)
  assert.equal(cache.textWidth(ctx, '-14.0LUFS', ctx.font), 108)
  setGlyphWidth(13)
  fonts.dispatchEvent(new Event('loadingdone'))
  assert.equal(cache.textWidth(ctx, '-14.0LUFS', ctx.font), 117)
  setGlyphWidth(14)
  fonts.dispatchEvent(new Event('loadingerror'))
  assert.equal(cache.textWidth(ctx, '-14.0LUFS', ctx.font), 126)

  cache.clear()
  setGlyphWidth(15)
  assert.equal(cache.textWidth(ctx, '-14.0LUFS', ctx.font), 135)
  cache.dispose()
})

test('changing labels cannot retain an unbounded history of measurements', () => {
  const { cache, ctx, measurements } = createFixture()
  cache.textWidth(ctx, 'old value', ctx.font)
  for (let index = 0; index < 1000; index += 1) cache.textWidth(ctx, String(index), ctx.font)
  const before = measurements()
  cache.textWidth(ctx, 'old value', ctx.font)
  assert.equal(measurements(), before + 1, 'old readouts are eventually evicted')
  cache.textWidth(ctx, 'old value', ctx.font)
  assert.equal(measurements(), before + 1, 'current readouts remain reusable')
  cache.dispose()
})

test('disposing a meter releases listeners from its owning document', () => {
  const { cache, ctx, fonts, measurements } = createFixture()
  cache.dispose()
  cache.textWidth(ctx, 'VU', ctx.font)
  fonts.dispatchEvent(new Event('loadingdone'))
  fonts.dispatchEvent(new Event('loadingerror'))
  cache.textWidth(ctx, 'VU', ctx.font)
  assert.equal(measurements(), 1)
})
