import assert from 'node:assert/strict'
import test from 'node:test'
import { NotchInteraction, normalizeNotchPrefs } from './notchState.ts'
import { DEFAULT_NOTCH_PREFS, type NotchPointer } from '../../types/notch.ts'
import type { MiniPlayerSnapshot } from '../../types/miniPlayer'

const prefs = { ...DEFAULT_NOTCH_PREFS, enabled: true }
const outside: NotchPointer = { near: false, proximity: 0, x: 0, y: 100, edgeDistance: 100, overHardware: false, motion: false, withinHover: false, inside: false, down: false, dragging: false, onActiveSpace: true }
function point(x: number, y: number): NotchPointer {
  const dx = Math.max(0, Math.abs(x) - 185 / 2)
  const overHardware = Math.abs(x) < 185 / 2 && y < 0 && y >= -32
  const proximity = overHardware ? 1 : y >= 0 ? Math.max(0, 1 - Math.hypot(dx / 52, y / 64)) : 0
  return { ...outside, x, y, edgeDistance: Math.hypot(dx, Math.max(0, y)), overHardware, motion: true, near: proximity > 0, proximity }
}
const near = point(0, 6)
function approach(state: NotchInteraction, arriveAt: number): void {
  state.pointer(point(0, 28), arriveAt - 50)
  state.pointer(near, arriveAt)
}
function snapshot(path: string | null, playbackState = 'playing'): MiniPlayerSnapshot {
  return { currentTrack: path ? { path } : null, playbackState } as MiniPlayerSnapshot
}
test('defaults are opt-in and preferences reject malformed values', () => {
  assert.deepEqual(normalizeNotchPrefs(null), DEFAULT_NOTCH_PREFS)
  assert.deepEqual(normalizeNotchPrefs({ enabled: 'true', restingView: 'queue', hoverEnabled: null }), DEFAULT_NOTCH_PREFS)
  assert.equal(normalizeNotchPrefs({ restingView: 'spectrum', trackChangePopups: false }).trackChangePopups, false)
})
test('a quick crossing only peeks; dragging stays hidden and deliberate dwell uses an exit grace period', () => {
  const state = new NotchInteraction(prefs)
  state.pointer(near, 0); state.tick(120)
  assert.equal(state.presentation.view, 'peek')
  state.pointer(outside, 130); state.tick(1000)
  assert.equal(state.presentation.view, 'hidden')
  state.pointer({ ...near, dragging: true }, 1000); state.tick(2000)
  assert.equal(state.presentation.view, 'hidden')
  approach(state, 2000); state.tick(2250)
  assert.equal(state.presentation.reason, 'hover')
  state.pointer(outside, 2300); state.tick(2499)
  assert.equal(state.presentation.reason, 'hover')
  state.pointer({ ...outside, inside: true }, 2499); state.tick(2700)
  assert.equal(state.presentation.reason, 'hover')
  state.pointer(outside, 2700); state.tick(2900)
  assert.equal(state.presentation.view, 'hidden')
})
test('pausing on a browser tab holds peek indefinitely with no reveal deadline', () => {
  const state = new NotchInteraction(prefs)
  state.pointer(point(0, 48), 0)
  assert.equal(state.presentation.view, 'peek')
  assert.equal(state.proximity, 0.25)
  state.pointer(point(0, 20), 100)
  assert.equal(state.proximity, 0.6875)
  assert.equal(state.deadline, null)
  state.tick(60_000)
  assert.equal(state.presentation.view, 'peek')
  // Continuing from the tab toward the edge supplies fresh intent.
  state.pointer(near, 60_050)
  assert.equal(state.deadline, 60_100)
  state.tick(60_099)
  assert.equal(state.presentation.view, 'peek')
  state.tick(60_100)
  assert.equal(state.presentation.reason, 'hover')
  assert.equal(state.proximity, 0)
})
test('sideways travel and stopping alongside the edge do not become inward intent', () => {
  const state = new NotchInteraction(prefs)
  for (const y of [20, 6]) {
    state.pointer(outside, 0)
    for (let i = 0; i <= 8; i++) {
      state.pointer(point(-80 + i * 20, y), i * 40); state.tick(i * 40)
      assert.equal(state.presentation.view, 'peek')
      assert.equal(state.deadline, null)
    }
    state.tick(10_000)
    assert.equal(state.presentation.view, 'peek')
  }
})
test('a directed approach opens promptly without restarting confirmation on continued inward motion', () => {
  const state = new NotchInteraction(prefs)
  approach(state, 50)
  assert.equal(state.deadline, 100)
  state.pointer(point(0, 4), 70)
  state.pointer(point(0, 2), 95)
  assert.equal(state.deadline, 100)
  state.pointer({ ...point(0, 2), motion: false, inside: true, withinHover: true }, 98)
  assert.equal(state.deadline, 100)
  state.tick(99)
  assert.equal(state.presentation.view, 'peek')
  state.tick(100)
  assert.equal(state.presentation.reason, 'hover')
})
test('fast passes through the intent area still cancel before the short confirmation', () => {
  for (const path of [
    [point(0, 28), point(0, 6), point(120, -4)],
    [point(130, 6), point(102, 6), point(80, 6)],
  ]) {
    const state = new NotchInteraction(prefs)
    state.pointer(path[0], 0); state.pointer(path[1], 16)
    assert.equal(state.deadline, 66)
    state.pointer(path[2], 32); state.tick(1000)
    assert.notEqual(state.presentation.reason, 'hover')
    assert.equal(state.deadline, null)
  }
})
test('turning toward a neighbouring tab or backing off cancels an earned reveal', () => {
  for (const changedDestination of [point(18, 6), point(0, 12), point(0, 24), point(120, -2)]) {
    const state = new NotchInteraction(prefs)
    approach(state, 50)
    state.pointer(changedDestination, 85)
    state.tick(5000)
    assert.notEqual(state.presentation.reason, 'hover')
    assert.equal(state.deadline, null)
  }
})
test('turning sideways just before reaching the edge discards earlier inward travel', () => {
  const state = new NotchInteraction(prefs)
  state.pointer(point(0, 40), 0)
  state.pointer(point(0, 14), 40)
  state.pointer(point(30, 12), 80)
  state.tick(5000)
  assert.equal(state.presentation.view, 'peek')
  assert.equal(state.deadline, null)
  state.pointer(point(30, 6), 5050)
  state.tick(5170)
  assert.equal(state.presentation.reason, 'hover', 'a fresh inward movement can still choose the notch')
})
test('slow and diagonal inward approaches work without a minimum cursor speed', () => {
  const state = new NotchInteraction(prefs)
  for (let y = 24; y >= 16; y--) {
    state.pointer(point(0, y), (24 - y) * 100)
    state.tick((24 - y) * 100)
    assert.equal(state.presentation.view, 'peek')
  }
  state.pointer(point(0, 15), 850)
  state.tick(850)
  assert.equal(state.presentation.reason, 'hover')
  const diagonal = new NotchInteraction(prefs)
  diagonal.pointer(point(-45, 40), 0)
  diagonal.pointer(point(-30, 20), 40)
  diagonal.pointer(point(-20, 6), 80)
  diagonal.tick(200)
  assert.equal(diagonal.presentation.reason, 'hover')
})
test('a stationary cursor, stale approach, or tiny jitter cannot manufacture intent at the lip', () => {
  const state = new NotchInteraction(prefs)
  state.pointer({ ...near, motion: false }, 0); state.tick(5000)
  assert.equal(state.deadline, null)
  for (let i = 0; i < 30; i++) state.pointer(point(i % 2 * 0.2, 6 + i % 2 * 0.2), 5100 + i * 20)
  state.tick(10_000)
  assert.equal(state.presentation.view, 'peek')
  assert.equal(state.deadline, null)
  const stale = new NotchInteraction(prefs)
  stale.pointer(point(0, 40), 0); stale.pointer(point(0, 18), 50)
  stale.pointer(point(0, 15), 5000); stale.tick(10_000)
  assert.equal(stale.presentation.view, 'peek')
  assert.equal(stale.deadline, null)
})
test('approaching from below may overshoot into the hardware without canceling or delaying reveal', () => {
  for (const x of [-70, 0, 70]) {
    const state = new NotchInteraction(prefs)
    state.pointer(point(x, 30), 0)
    state.pointer(point(x, 8), 30)
    assert.equal(state.deadline, 80)
    state.pointer(point(x, -2), 45)
    state.pointer(point(x, -25), 60)
    state.pointer({ ...point(x, -25), motion: false }, 70)
    assert.equal(state.deadline, 80)
    state.tick(80)
    assert.equal(state.presentation.reason, 'hover')
    state.pointer(point(x, -20), 100); state.tick(1000)
    assert.equal(state.presentation.reason, 'hover', 'hardware retains an existing preview')
    state.pointer(point(120, -20), 1100); state.tick(1300)
    assert.equal(state.presentation.view, 'hidden', 'adjacent menu items do not retain it')
  }
})
test('a jump straight into the hardware works after a short pause, but a menu-bar crossing does not', () => {
  const direct = new NotchInteraction(prefs)
  direct.pointer({ ...point(0, -12), motion: false }, 0)
  direct.tick(1000)
  assert.equal(direct.deadline, null, 'appearing beneath a stationary cursor cannot open it')
  direct.pointer(point(0, -12), 1010)
  direct.tick(1159)
  assert.equal(direct.presentation.view, 'peek')
  direct.tick(1160)
  assert.equal(direct.presentation.reason, 'hover')

  const crossing = new NotchInteraction(prefs)
  for (let x = -120; x <= 120; x += 20) {
    crossing.pointer(point(x, -12), (x + 120) * 2)
    crossing.tick((x + 120) * 2)
    assert.notEqual(crossing.presentation.reason, 'hover')
  }
  crossing.tick(5000)
  assert.equal(crossing.presentation.view, 'hidden')
  assert.equal(crossing.deadline, null)
})
test('nearby, shallow diagonal, and slightly curved approaches do not require precise aiming', () => {
  const paths = [
    [[0, 10], [0, 5]],
    [[0, 30], [0, 15]],
    [[-60, 36], [-40, 24], [-20, 12], [-10, 6]],
    [[0, 30], [0, 19], [3, 18], [4, 15], [6, 14]],
    [[0, 28], [0, 6], [3, 8], [5, 6]],
  ]
  for (const path of paths) {
    const state = new NotchInteraction(prefs)
    path.forEach(([x, y], i) => state.pointer(point(x, y), i * 10))
    state.tick(150)
    assert.equal(state.presentation.reason, 'hover', JSON.stringify(path))
  }
})
test('small successive sideways steps still cancel intent, and dismissal also suppresses the hardware target', () => {
  const state = new NotchInteraction(prefs)
  approach(state, 50)
  for (let x = 2; x <= 14; x += 2) state.pointer(point(x, 6), 50 + x * 2)
  state.tick(1000)
  assert.equal(state.deadline, null)
  assert.equal(state.presentation.view, 'peek')
  state.pointer(point(14, -10), 1010); state.tick(1200)
  assert.equal(state.presentation.reason, 'hover')
  state.expand(); state.collapse()
  state.pointer(point(14, -12), 1250); state.tick(1500)
  assert.equal(state.presentation.view, 'hidden')
  state.pointer(outside, 1510)
  state.pointer(point(14, -12), 1520); state.tick(1670)
  assert.equal(state.presentation.reason, 'hover')
})
test('the visible persistent strip can be approached across its full height', () => {
  const state = new NotchInteraction({ ...prefs, restingView: 'oscilloscope' })
  state.snapshot(snapshot('a'), 0)
  state.pointer(point(0, 40), 10); state.pointer(point(0, 20), 60)
  state.tick(180)
  assert.equal(state.presentation.reason, 'hover')
})
test('animated edges cannot initiate a reveal; the exit buffer retains an existing preview', () => {
  const state = new NotchInteraction(prefs)
  const buffer = { ...outside, withinHover: true }
  state.pointer(buffer, 0); state.tick(1000)
  assert.equal(state.presentation.view, 'hidden')
  assert.equal(state.deadline, null)
  approach(state, 1000); state.tick(1180)
  state.pointer(buffer, 1200); state.tick(2000)
  assert.equal(state.presentation.reason, 'hover')
  state.pointer(outside, 2100); state.tick(2299)
  assert.equal(state.presentation.reason, 'hover')
  state.tick(2300)
  assert.equal(state.presentation.view, 'hidden')
})
test('notifications outrank proximity and disabling hover clears a pending peek', () => {
  const state = new NotchInteraction(prefs)
  state.snapshot(snapshot('a'), 0)
  state.pointer(near, 100)
  assert.equal(state.presentation.view, 'peek')
  state.snapshot(snapshot('b'), 110)
  assert.equal(state.presentation.reason, 'notification')
  state.expand(); state.pointer(near, 120)
  assert.equal(state.presentation.view, 'expanded')
  state.collapse(); state.pointer(outside, 200); state.pointer(near, 300)
  assert.equal(state.presentation.view, 'peek')
  state.configure({ ...prefs, hoverEnabled: false }); state.tick(1000)
  assert.equal(state.presentation.view, 'hidden')
  assert.equal(state.proximity, 0)
})
test('clicked player stays open on exit, outside click collapses and explicit dismissal suppresses rehover', () => {
  const state = new NotchInteraction(prefs)
  approach(state, 50); state.tick(250); state.expand()
  state.pointer(outside, 300); state.tick(1000)
  assert.equal(state.presentation.view, 'expanded')
  state.pointer({ ...outside, down: true }, 1100)
  assert.equal(state.presentation.view, 'hidden')
  state.pointer(near, 1200); state.tick(1450); state.expand(); state.collapse()
  state.pointer(near, 1500); state.tick(2000)
  assert.equal(state.presentation.view, 'hidden')
  state.pointer(outside, 2100); approach(state, 2200); state.tick(2450)
  assert.equal(state.presentation.reason, 'hover')
})
test('initial snapshots do not notify; new playing tracks coalesce and expanded wins', () => {
  const state = new NotchInteraction(prefs)
  state.snapshot(snapshot('a'), 0)
  assert.equal(state.presentation.view, 'hidden')
  state.snapshot(snapshot('b', 'loading'), 100)
  assert.equal(state.presentation.view, 'hidden')
  state.snapshot(snapshot('b'), 200)
  assert.equal(state.presentation.reason, 'notification')
  state.snapshot(snapshot('b'), 1000)
  assert.equal(state.deadline, 3200)
  state.snapshot(snapshot('c'), 3000); state.tick(3200)
  assert.equal(state.deadline, 6000)
  state.expand(); state.snapshot(snapshot('d'), 4000); state.tick(7000)
  assert.equal(state.presentation.view, 'expanded')
  state.collapse()
  assert.equal(state.presentation.view, 'hidden')
})
test('persistent content returns after popups and remains paused; empty track stays hidden', () => {
  const state = new NotchInteraction({ ...prefs, restingView: 'oscilloscope' })
  state.snapshot(snapshot('a', 'paused'), 0)
  assert.equal(state.presentation.view, 'oscilloscope')
  state.snapshot(snapshot('b'), 100); state.tick(3100)
  assert.equal(state.presentation.view, 'oscilloscope')
  state.snapshot(snapshot(null), 3200)
  assert.equal(state.presentation.view, 'hidden')
  approach(state, 3300); state.tick(3550)
  assert.equal(state.presentation.reason, 'hover')
})
test('hover and notifications can be disabled independently', () => {
  const state = new NotchInteraction({ ...prefs, hoverEnabled: false })
  state.pointer(near, 0); state.tick(500)
  assert.equal(state.presentation.view, 'hidden')
  state.snapshot(snapshot('a'), 600); state.snapshot(snapshot('b'), 700)
  assert.equal(state.presentation.reason, 'notification')
  state.configure({ ...prefs, trackChangePopups: false })
  assert.equal(state.presentation.view, 'hidden')
  approach(state, 800); state.tick(1050)
  assert.equal(state.presentation.reason, 'hover')
})
test('tracks observed while suspended do not produce stale popups on return', () => {
  const state = new NotchInteraction(prefs)
  state.snapshot(snapshot('a'), 0)
  state.snapshot(snapshot('b'), 100, false)
  state.snapshot(snapshot('b'), 200, true)
  assert.equal(state.presentation.view, 'hidden')
})

test('foreground hides every automatic resting view while keeping proximity, hover, and expansion available', () => {
  for (const restingView of ['hidden', 'metadata', 'oscilloscope', 'spectrum'] as const) {
    const state = new NotchInteraction({ ...prefs, restingView })
    state.snapshot(snapshot('a'), 0)
    state.setMainWindowForeground(true)
    assert.deepEqual(state.presentation, { view: 'hidden', reason: 'resting' })
    approach(state, 60)
    assert.equal(state.presentation.view, 'peek')
    state.tick(190)
    assert.deepEqual(state.presentation, { view: 'metadata', reason: 'hover' })
    state.expand(); state.snapshot(snapshot('b'), 200)
    assert.equal(state.presentation.view, 'expanded')
    state.collapse(); state.pointer(outside, 210)
    assert.equal(state.presentation.view, 'hidden')
    state.setMainWindowForeground(false)
    assert.deepEqual(state.presentation, { view: restingView, reason: 'resting' })
  }
})

test('foreground clears active and loading-track notifications without replaying them on blur', () => {
  const state = new NotchInteraction(prefs)
  state.snapshot(snapshot('a'), 0)
  state.snapshot(snapshot('b'), 10)
  assert.equal(state.presentation.reason, 'notification')
  state.setMainWindowForeground(true)
  assert.equal(state.presentation.view, 'hidden')
  assert.equal(state.deadline, null)
  state.snapshot(snapshot('c'), 20)
  state.snapshot(snapshot('d', 'loading'), 30)
  state.setMainWindowForeground(false)
  state.snapshot(snapshot('d'), 40)
  assert.equal(state.presentation.view, 'hidden')
  state.snapshot(snapshot('e', 'loading'), 50)
  state.setMainWindowForeground(true); state.setMainWindowForeground(false)
  state.snapshot(snapshot('e'), 60)
  assert.equal(state.presentation.view, 'hidden')
  state.snapshot(snapshot('f'), 70)
  assert.equal(state.presentation.reason, 'notification')
})
