import assert from 'node:assert/strict'
import test from 'node:test'
import { SpectrumHeatmapColors } from './spectrumHeatmapColors.ts'

test('cached heat colors preserve the existing CSS channels and alpha rounding', () => {
  const palette = new Uint8ClampedArray(256 * 4)
  for (let i = 0; i < 256; i++) palette.set([i, 255 - i, 73, 255], i * 4)
  const colors = new SpectrumHeatmapColors(palette)
  for (let pass = 0; pass < 2; pass++) {
    for (let index = 0; index < 256; index++) {
      for (const alpha of [1, 37, 127, 128, 254, 255]) {
        const expected = alpha === 255
          ? `rgb(${index}, ${255 - index}, 73)`
          : `rgba(${index}, ${255 - index}, 73, ${Number((alpha / 255).toFixed(3))})`
        assert.equal(colors.getStyle(index, alpha), expected)
      }
    }
  }
})

test('intensities in the same palette bin retain their distinct final alpha', () => {
  const palette = new Uint8ClampedArray(256 * 4)
  palette.set([51, 102, 153, 200], 127 * 4)
  const colors = new SpectrumHeatmapColors(palette)
  const lowerIntensity = 126.6 / 255
  const upperIntensity = 127.4 / 255
  assert.equal(Math.round(lowerIntensity * 255), Math.round(upperIntensity * 255))
  const lowerAlpha = Math.round(200 * lowerIntensity)
  const upperAlpha = Math.round(200 * upperIntensity)
  assert.equal(colors.getStyle(127, lowerAlpha), 'rgba(51, 102, 153, 0.388)')
  assert.equal(colors.getStyle(127, upperAlpha), 'rgba(51, 102, 153, 0.392)')
  assert.equal(colors.getStyle(127, lowerAlpha), 'rgba(51, 102, 153, 0.388)')
})

test('palette changes invalidate previously cached styles', () => {
  const first = Uint8ClampedArray.of(255, 0, 0, 255)
  const second = Uint8ClampedArray.of(0, 0, 255, 255)
  const colors = new SpectrumHeatmapColors(first)
  assert.equal(colors.getStyle(0, 255), 'rgb(255, 0, 0)')
  colors.reset(second)
  assert.equal(colors.getStyle(0, 255), 'rgb(0, 0, 255)')
  colors.reset()
  assert.equal(colors.getStyle(0, 255), 'rgb(0, 0, 255)')
})
