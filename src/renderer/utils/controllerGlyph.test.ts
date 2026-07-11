import test from 'node:test'
import assert from 'node:assert/strict'
import type { ControllerButtonRole, ControllerFamily } from '../types/controller.ts'
import { getControllerGlyphKind } from './controllerGlyph.ts'

const ROLES: ControllerButtonRole[] = [
  'activate',
  'back',
  'playPause',
  'queue',
  'radialMenu',
  'bumperLeft',
  'bumperRight',
  'triggerLeft',
  'triggerRight',
  'stickLeft',
  'stickRight'
]

const FAMILIES: ControllerFamily[] = ['xbox', 'playstation']

test('every button role resolves to a concrete glyph for both families', () => {
  for (const family of FAMILIES) {
    for (const button of ROLES) {
      const kind = getControllerGlyphKind(family, button)
      assert.ok(kind, `missing glyph for ${family}/${button}`)
      if (kind.type === 'letter') {
        assert.ok(kind.letter.length > 0, `empty letter for ${family}/${button}`)
      }
      if (kind.type === 'labelled') {
        assert.ok(kind.label.length > 0, `empty label for ${family}/${button}`)
      }
    }
  }
})

test('PlayStation face buttons are geometric shapes', () => {
  assert.deepEqual(getControllerGlyphKind('playstation', 'activate'), { type: 'shape', shape: 'cross' })
  assert.deepEqual(getControllerGlyphKind('playstation', 'back'), { type: 'shape', shape: 'circle' })
  assert.deepEqual(getControllerGlyphKind('playstation', 'playPause'), { type: 'shape', shape: 'square' })
  assert.deepEqual(getControllerGlyphKind('playstation', 'queue'), { type: 'shape', shape: 'triangle' })
})

test('Xbox face buttons are lettered', () => {
  assert.deepEqual(getControllerGlyphKind('xbox', 'activate'), { type: 'letter', letter: 'A' })
  assert.deepEqual(getControllerGlyphKind('xbox', 'queue'), { type: 'letter', letter: 'Y' })
})

test('shoulders, triggers and sticks carry the hardware label', () => {
  assert.deepEqual(getControllerGlyphKind('playstation', 'bumperLeft'), {
    type: 'labelled',
    variant: 'bumper',
    label: 'L1'
  })
  assert.deepEqual(getControllerGlyphKind('xbox', 'triggerRight'), {
    type: 'labelled',
    variant: 'trigger',
    label: 'RT'
  })
  assert.deepEqual(getControllerGlyphKind('xbox', 'stickLeft'), {
    type: 'labelled',
    variant: 'stick',
    label: 'L3'
  })
})
