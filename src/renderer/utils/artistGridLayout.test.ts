import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveArtistGridLayout } from './artistGridLayout.ts'

test('artist grid layout keeps one fallback column before width is measured', () => {
  assert.deepEqual(resolveArtistGridLayout({
    containerWidth: 0,
    itemCount: 7,
    minColumnWidth: 124,
    gap: 12
  }), {
    columnCount: 1,
    rowCount: 7,
    columnWidth: 124
  })
})

test('artist grid layout uses one column for narrow containers', () => {
  assert.deepEqual(resolveArtistGridLayout({
    containerWidth: 150,
    itemCount: 5,
    minColumnWidth: 124,
    gap: 12
  }), {
    columnCount: 1,
    rowCount: 5,
    columnWidth: 150
  })
})

test('artist grid layout lets a single column collapse below its preferred width', () => {
  assert.deepEqual(resolveArtistGridLayout({
    containerWidth: 73,
    itemCount: 5,
    minColumnWidth: 124,
    gap: 12
  }), {
    columnCount: 1,
    rowCount: 5,
    columnWidth: 73
  })
})

test('artist grid layout changes columns exactly at the minimum-width breakpoint', () => {
  assert.deepEqual(resolveArtistGridLayout({
    containerWidth: 333,
    itemCount: 8,
    minColumnWidth: 160,
    gap: 14
  }), {
    columnCount: 1,
    rowCount: 8,
    columnWidth: 333
  })

  assert.deepEqual(resolveArtistGridLayout({
    containerWidth: 334,
    itemCount: 8,
    minColumnWidth: 160,
    gap: 14
  }), {
    columnCount: 2,
    rowCount: 4,
    columnWidth: 167
  })
})

test('artist grid layout expands columns for wide containers', () => {
  assert.deepEqual(resolveArtistGridLayout({
    containerWidth: 600,
    itemCount: 20,
    minColumnWidth: 124,
    gap: 12
  }), {
    columnCount: 4,
    rowCount: 5,
    columnWidth: 150
  })
})

test('artist grid layout uses the scrollbar-adjusted content width', () => {
  const outerWidth = 600
  const classicScrollbarWidth = 15

  assert.deepEqual(resolveArtistGridLayout({
    containerWidth: outerWidth - classicScrollbarWidth,
    itemCount: 20,
    minColumnWidth: 124,
    gap: 12
  }), {
    columnCount: 4,
    rowCount: 5,
    columnWidth: 146
  })
})

test('artist grid layout accounts for a partial final row', () => {
  assert.deepEqual(resolveArtistGridLayout({
    containerWidth: 600,
    itemCount: 10,
    minColumnWidth: 124,
    gap: 12
  }), {
    columnCount: 4,
    rowCount: 3,
    columnWidth: 150
  })
})

test('artist grid layout never makes its columns wider than the available content box', () => {
  const widths = [1, 73, 123, 124, 135, 333, 334, 585, 600, 1023.75]

  for (const containerWidth of widths) {
    const layout = resolveArtistGridLayout({
      containerWidth,
      itemCount: 100,
      minColumnWidth: 124,
      gap: 12
    })

    assert.ok(
      layout.columnCount * layout.columnWidth <= Math.floor(containerWidth),
      `expected ${layout.columnCount} columns at ${layout.columnWidth}px to fit within ${containerWidth}px`
    )
  }
})

test('artist grid layout preserves card width for sparse filtered results', () => {
  assert.deepEqual(resolveArtistGridLayout({
    containerWidth: 600,
    itemCount: 1,
    minColumnWidth: 124,
    gap: 12
  }), {
    columnCount: 4,
    rowCount: 1,
    columnWidth: 150
  })
})

test('artist grid layout returns no rows for empty data', () => {
  assert.deepEqual(resolveArtistGridLayout({
    containerWidth: 600,
    itemCount: 0,
    minColumnWidth: 124,
    gap: 12
  }), {
    columnCount: 1,
    rowCount: 0,
    columnWidth: 124
  })
})
