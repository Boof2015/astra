import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDefaultRootTrackTableLayout,
  getTrackSortDirectionLabel,
  getVisibleRootTrackColumnIds,
  normalizeRootTrackTableLayout,
  normalizeTrackSortRules,
  reorderTrackSortRules,
  replaceTrackSortRulesFromHeader,
  resolveRootTrackColumns
} from './rootTrackTable.ts'

test('root track table defaults preserve existing optional visibility and keep Year hidden', () => {
  const layout = createDefaultRootTrackTableLayout({ showBpmKey: true, showGenre: true })
  const visible = getVisibleRootTrackColumnIds(layout)
  assert.equal(visible.has('title'), true)
  assert.equal(visible.has('bpm'), true)
  assert.equal(visible.has('musical_key'), true)
  assert.equal(visible.has('genre'), true)
  assert.equal(visible.has('year'), false)
})

test('root track table normalization pins Title, drops duplicates, appends missing fields, and removes legacy widths', () => {
  const layout = normalizeRootTrackTableLayout({
    columns: [
      { id: 'artist', visible: true, width: 1 },
      { id: 'title', visible: false, width: 9000 },
      { id: 'artist', visible: false, width: 200 },
      { id: 'unknown', visible: true, width: 100 }
    ]
  })
  assert.equal(layout.columns[0].id, 'title')
  assert.equal(layout.columns[0].visible, true)
  assert.equal(layout.columns.filter((entry) => entry.id === 'artist').length, 1)
  assert.equal('width' in (layout.columns.find((entry) => entry.id === 'artist') ?? {}), false)
  assert.equal('width' in (layout.columns.find((entry) => entry.id === 'title') ?? {}), false)
  assert.equal(layout.columns.length, 12)
})

test('track sort rule normalization migrates a single rule, removes duplicates and hidden fields', () => {
  assert.deepEqual(normalizeTrackSortRules({ key: 'year', direction: 'desc' }), [
    { key: 'year', direction: 'desc' }
  ])
  assert.deepEqual(normalizeTrackSortRules([
    { key: 'artist', direction: 'desc' },
    { key: 'artist', direction: 'asc' },
    { key: 'rating', direction: 'desc' }
  ], { visibleColumns: new Set(['title', 'artist']), ratingsEnabled: false }), [
    { key: 'artist', direction: 'desc' }
  ])
  assert.deepEqual(normalizeTrackSortRules([], { visibleColumns: new Set(['title']) }), [
    { key: 'title', direction: 'asc' }
  ])
})

test('root track sorting can retain rules for columns hidden from the table', () => {
  assert.deepEqual(normalizeTrackSortRules([
    { key: 'added', direction: 'desc' },
    { key: 'artist', direction: 'asc' }
  ], { ratingsEnabled: true }), [
    { key: 'added', direction: 'desc' },
    { key: 'artist', direction: 'asc' }
  ])
})

test('track sort directions have field-specific semantic labels', () => {
  assert.equal(getTrackSortDirectionLabel('title', 'asc'), 'A–Z')
  assert.equal(getTrackSortDirectionLabel('added', 'desc'), 'Newest first')
  assert.equal(getTrackSortDirectionLabel('bpm', 'asc'), 'Lowest first')
  assert.equal(getTrackSortDirectionLabel('play_count', 'desc'), 'Most played')
  assert.equal(getTrackSortDirectionLabel('duration', 'asc'), 'Shortest first')
})

test('header sorting replaces a multikey stack and only repeated single-key clicks reverse it', () => {
  const multikey = [
    { key: 'artist' as const, direction: 'asc' as const },
    { key: 'year' as const, direction: 'desc' as const }
  ]
  assert.deepEqual(replaceTrackSortRulesFromHeader(multikey, 'artist'), [
    { key: 'artist', direction: 'asc' }
  ])
  assert.deepEqual(replaceTrackSortRulesFromHeader([{ key: 'artist', direction: 'asc' }], 'artist'), [
    { key: 'artist', direction: 'desc' }
  ])
  assert.deepEqual(replaceTrackSortRulesFromHeader(multikey, 'year'), [
    { key: 'year', direction: 'desc' }
  ])
})

test('sort priorities reorder deterministically without changing their directions', () => {
  assert.deepEqual(reorderTrackSortRules([
    { key: 'artist', direction: 'asc' },
    { key: 'year', direction: 'desc' },
    { key: 'album', direction: 'asc' }
  ], 2, 0), [
    { key: 'album', direction: 'asc' },
    { key: 'artist', direction: 'asc' },
    { key: 'year', direction: 'desc' }
  ])
})

test('responsive layout hides requested columns from right to left without mutating layout', () => {
  const layout = createDefaultRootTrackTableLayout({ showBpmKey: true, showGenre: true, showAdded: true })
  const original = structuredClone(layout)
  const wide = resolveRootTrackColumns(layout, 1600, 160)
  assert.equal(wide.responsiveHiddenColumns.length, 0)
  assert.equal(wide.visibleColumns.every((entry) => !('width' in entry)), true)

  const narrow = resolveRootTrackColumns(layout, 520, 160)
  assert.ok(narrow.responsiveHiddenColumns.length > 0)
  assert.equal(narrow.responsiveHiddenColumns.includes('duration'), true)
  assert.equal(narrow.visibleColumns[0].id, 'title')
  assert.deepEqual(layout, original)

  const restored = resolveRootTrackColumns(layout, 1600, 160)
  assert.deepEqual(restored.visibleColumns.map((entry) => entry.id), wide.visibleColumns.map((entry) => entry.id))
})
