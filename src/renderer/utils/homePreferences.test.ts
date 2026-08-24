import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_HOME_LAYOUT_PREFERENCE,
  DEFAULT_HOME_SKY_TIME_PREFERENCE,
  formatHomeSkyTime,
  getRoundedCurrentSkyMinutes,
  moveHomeModule,
  normalizeHomeLayoutPreference,
  normalizeHomeSkyFixedMinutes,
  normalizeHomeSkyTimePreference,
  resolveHomeSkyDate,
  setHomeModuleVisible,
  setHomeSkyTimeModePreference
} from './homePreferences.ts'

test('sky time normalization snaps and clamps half-hour values', () => {
  assert.equal(normalizeHomeSkyFixedMinutes(44), 30)
  assert.equal(normalizeHomeSkyFixedMinutes(46), 60)
  assert.equal(normalizeHomeSkyFixedMinutes(-50), 0)
  assert.equal(normalizeHomeSkyFixedMinutes(9999), 1410)
  assert.equal(normalizeHomeSkyFixedMinutes('bad'), null)
})

test('sky preference preserves a normalized fixed value and defaults malformed input', () => {
  assert.deepEqual(normalizeHomeSkyTimePreference({ mode: 'fixed', fixedMinutes: 377 }), {
    mode: 'fixed',
    fixedMinutes: 390
  })
  assert.deepEqual(normalizeHomeSkyTimePreference({ mode: 'unknown', fixedMinutes: 90 }), {
    mode: 'realtime',
    fixedMinutes: 90
  })
  assert.deepEqual(normalizeHomeSkyTimePreference({ mode: 'fixed', fixedMinutes: 'bad' }), {
    mode: 'realtime',
    fixedMinutes: null
  })
  assert.deepEqual(normalizeHomeSkyTimePreference(null), DEFAULT_HOME_SKY_TIME_PREFERENCE)
})

test('first fixed time rounds to the nearest half hour and wraps midnight', () => {
  assert.equal(getRoundedCurrentSkyMinutes(new Date(2026, 0, 1, 18, 16)), 1110)
  assert.equal(getRoundedCurrentSkyMinutes(new Date(2026, 0, 1, 23, 52)), 0)
  const initialized = setHomeSkyTimeModePreference(
    DEFAULT_HOME_SKY_TIME_PREFERENCE,
    'fixed',
    new Date(2026, 0, 1, 18, 16)
  )
  assert.deepEqual(initialized, { mode: 'fixed', fixedMinutes: 1110 })
  assert.deepEqual(setHomeSkyTimeModePreference(initialized, 'realtime'), {
    mode: 'realtime',
    fixedMinutes: 1110
  })
  assert.deepEqual(setHomeSkyTimeModePreference({ mode: 'realtime', fixedMinutes: 1110 }, 'fixed'), initialized)
})

test('fixed sky date changes only the local clock fields', () => {
  const real = new Date(2026, 7, 11, 14, 17, 23, 456)
  const fixed = resolveHomeSkyDate(real, { mode: 'fixed', fixedMinutes: 90 })
  assert.equal(fixed.getFullYear(), real.getFullYear())
  assert.equal(fixed.getMonth(), real.getMonth())
  assert.equal(fixed.getDate(), real.getDate())
  assert.equal(fixed.getHours(), 1)
  assert.equal(fixed.getMinutes(), 30)
  assert.equal(fixed.getSeconds(), 0)
  assert.equal(real.getHours(), 14)
})

test('sky time formatting uses the requested locale', () => {
  assert.equal(formatHomeSkyTime(0, 'en-US'), '12:00 AM')
  assert.equal(formatHomeSkyTime(18 * 60, 'en-US'), '6:00 PM')
})

test('home layout defaults to three visible modules', () => {
  const normalized = normalizeHomeLayoutPreference(null)
  assert.deepEqual(normalized, DEFAULT_HOME_LAYOUT_PREFERENCE)
  assert.deepEqual(
    normalized.modules.filter((module) => module.visible).map((module) => module.id),
    ['jump-back-in', 'rediscover', 'pinned-playlists']
  )
})

test('home layout retains known order and appends future-known omissions disabled', () => {
  const normalized = normalizeHomeLayoutPreference({
    version: 1,
    modules: [
      { id: 'rediscover', visible: true },
      { id: 'jump-back-in', visible: false },
      { id: 'unknown', visible: true },
      { id: 'rediscover', visible: false }
    ]
  })
  assert.deepEqual(normalized.modules.slice(0, 2), [
    { id: 'rediscover', visible: true },
    { id: 'jump-back-in', visible: false }
  ])
  assert.equal(normalized.modules.find((module) => module.id === 'pinned-playlists')?.visible, false)
})

test('home modules can be toggled and reordered without mutating the source', () => {
  const source = normalizeHomeLayoutPreference(DEFAULT_HOME_LAYOUT_PREFERENCE)
  const hidden = setHomeModuleVisible(source, 'rediscover', false)
  const moved = moveHomeModule(hidden, 'pinned-playlists', 0)
  assert.equal(source.modules.find((module) => module.id === 'rediscover')?.visible, true)
  assert.equal(hidden.modules.find((module) => module.id === 'rediscover')?.visible, false)
  assert.equal(moved.modules[0]?.id, 'pinned-playlists')
})
