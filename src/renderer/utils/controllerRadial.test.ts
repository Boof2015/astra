import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createControllerRadialRoot,
  getControllerRadialView,
  resolveControllerRadialActivation,
  resolveControllerRadialBack,
  selectControllerRadialIndexFromVector
} from './controllerRadial.ts'

test('selects radial slices from stick or d-pad vectors', () => {
  assert.equal(selectControllerRadialIndexFromVector(8, { x: 0, y: -1 }), 0)
  assert.equal(selectControllerRadialIndexFromVector(8, { x: 1, y: 0 }), 2)
  assert.equal(selectControllerRadialIndexFromVector(8, { x: 0, y: 1 }), 4)
  assert.equal(selectControllerRadialIndexFromVector(8, { x: -1, y: 0 }), 6)
  assert.equal(selectControllerRadialIndexFromVector(8, { x: 0.1, y: 0.1 }), null)
})

test('aiming at a slice center selects that slice, not the next one', () => {
  // Vector pointing `degFromTop` degrees clockwise from straight up.
  const aim = (degFromTop: number) => {
    const rad = (degFromTop * Math.PI) / 180
    return { x: Math.sin(rad), y: -Math.cos(rad) }
  }
  // 8 slices → 45° each; slice `i` is centered at 45·(i + 0.5)°. These land mid-wedge,
  // which the old round()-based logic pushed to `i + 1`.
  assert.equal(selectControllerRadialIndexFromVector(8, aim(22.5)), 0)
  assert.equal(selectControllerRadialIndexFromVector(8, aim(67.5)), 1)
  assert.equal(selectControllerRadialIndexFromVector(8, aim(112.5)), 2)
  assert.equal(selectControllerRadialIndexFromVector(8, aim(337.5)), 7)
  // 5 slices → 72° each; matches the live root menu layout (More/Browse/Playback/Volume/Queue).
  assert.equal(selectControllerRadialIndexFromVector(5, aim(36)), 0)
  assert.equal(selectControllerRadialIndexFromVector(5, aim(108)), 1)
  assert.equal(selectControllerRadialIndexFromVector(5, aim(180)), 2)
})

test('enters submenus and returns to the parent before closing', () => {
  const root = createControllerRadialRoot({ canOpenContext: true, showQueue: false })
  const enterBrowse = resolveControllerRadialActivation(root, [], 1)

  assert.deepEqual(enterBrowse, { type: 'enter', path: ['browse'] })
  assert.equal(getControllerRadialView(root, ['browse']).title, 'Browse')
  assert.deepEqual(resolveControllerRadialBack(['browse']), { type: 'parent', path: [] })
  assert.deepEqual(resolveControllerRadialBack([]), { type: 'close' })
})

test('executes direct actions and keeps volume actions open', () => {
  const root = createControllerRadialRoot({ canOpenContext: true, showQueue: false })

  assert.deepEqual(resolveControllerRadialActivation(root, [], 4), {
    type: 'execute',
    action: 'toggle-queue',
    keepOpen: false
  })
  assert.deepEqual(resolveControllerRadialActivation(root, ['volume'], 0), {
    type: 'execute',
    action: 'volume-up',
    keepOpen: true
  })
  assert.deepEqual(resolveControllerRadialActivation(root, ['volume'], 2), {
    type: 'execute',
    action: 'volume-down',
    keepOpen: true
  })
})

test('disabled more item does not fire without a context target', () => {
  const root = createControllerRadialRoot({ canOpenContext: false, showQueue: false })

  assert.deepEqual(resolveControllerRadialActivation(root, [], 0), { type: 'noop' })
})
