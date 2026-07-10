import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  azimuthDegToStagePosition,
  circularDistanceDeg,
  clampAzimuthToMinSeparation,
  normalizeAzimuthDeg,
  pointerToAzimuthDeg,
  snapAzimuthDeg,
} from './virtualSpeakerRoomGeometry.ts'

function approx(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} ≈ ${expected}`)
}

test('normalizeAzimuthDeg wraps into (-180, 180]', () => {
  assert.equal(normalizeAzimuthDeg(0), 0)
  assert.equal(normalizeAzimuthDeg(180), 180)
  assert.equal(normalizeAzimuthDeg(-180), 180)
  assert.equal(normalizeAzimuthDeg(190), -170)
  assert.equal(normalizeAzimuthDeg(-190), 170)
  assert.equal(normalizeAzimuthDeg(540), 180)
  assert.equal(normalizeAzimuthDeg(Number.NaN), 0)
})

test('azimuthDegToStagePosition places the cardinal directions correctly', () => {
  const front = azimuthDegToStagePosition(0, 100)
  approx(front.x, 0)
  approx(front.y, -100) // front = up

  const right = azimuthDegToStagePosition(90, 100)
  approx(right.x, 100)
  approx(right.y, 0)

  const back = azimuthDegToStagePosition(180, 100)
  approx(back.x, 0)
  approx(back.y, 100)

  const left = azimuthDegToStagePosition(-90, 100)
  approx(left.x, -100)
  approx(left.y, 0)
})

test('pointerToAzimuthDeg inverts azimuthDegToStagePosition', () => {
  for (const deg of [-179, -110, -45, -30, 0, 30, 45, 90, 110, 150, 180]) {
    const point = azimuthDegToStagePosition(deg, 87)
    approx(pointerToAzimuthDeg(point.x, point.y), deg, 1e-6)
  }
  assert.equal(pointerToAzimuthDeg(0, 0), 0)
})

test('snapAzimuthDeg snaps to the step grid', () => {
  assert.equal(snapAzimuthDeg(-29.6, 1), -30)
  assert.equal(snapAzimuthDeg(-28.4, 5), -30)
  assert.equal(snapAzimuthDeg(112.5, 5), 115)
  assert.equal(snapAzimuthDeg(179.9, 1), 180)
})

test('circularDistanceDeg takes the short way around', () => {
  assert.equal(circularDistanceDeg(170, -170), 20)
  assert.equal(circularDistanceDeg(-170, 170), -20)
  assert.equal(circularDistanceDeg(0, 90), 90)
})

test('clampAzimuthToMinSeparation keeps speakers apart', () => {
  // No conflict: unchanged.
  assert.equal(clampAzimuthToMinSeparation(-30, [30, 110], 4), -30)
  // Direct conflict: pushed to the separation boundary.
  assert.equal(clampAzimuthToMinSeparation(31, [30], 4), 34)
  assert.equal(clampAzimuthToMinSeparation(29, [30], 4), 26)
  // Exactly on top of another speaker: pushed off deterministically.
  assert.equal(Math.abs(circularDistanceDeg(30, clampAzimuthToMinSeparation(30, [30], 4))), 4)
  // Wraps across the seam.
  const clamped = clampAzimuthToMinSeparation(179, [-179], 4)
  assert.ok(Math.abs(circularDistanceDeg(-179, clamped)) >= 4 - 1e-9)
})
