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
