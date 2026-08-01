import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveYearAlbumPreviewLayout } from './yearAlbumPreview.ts'

test('year album preview shows two responsive rows before overflowing', () => {
  assert.deepEqual(resolveYearAlbumPreviewLayout({
    containerWidth: 220,
    itemCount: 8
  }), {
    columnCount: 1,
    collapsedItemCount: 2,
    hasOverflow: true
  })

  assert.deepEqual(resolveYearAlbumPreviewLayout({
    containerWidth: 684,
    itemCount: 8
  }), {
    columnCount: 3,
    collapsedItemCount: 6,
    hasOverflow: true
  })
})

test('year album preview exposes more items after a wider resize', () => {
  const narrow = resolveYearAlbumPreviewLayout({ containerWidth: 684, itemCount: 12 })
  const wide = resolveYearAlbumPreviewLayout({ containerWidth: 1148, itemCount: 12 })

  assert.equal(narrow.collapsedItemCount, 6)
  assert.equal(wide.collapsedItemCount, 10)
  assert.equal(narrow.hasOverflow, true)
  assert.equal(wide.hasOverflow, true)
})

test('year album preview omits disclosure when every album fits', () => {
  assert.deepEqual(resolveYearAlbumPreviewLayout({
    containerWidth: 684,
    itemCount: 5
  }), {
    columnCount: 3,
    collapsedItemCount: 5,
    hasOverflow: false
  })
})

test('year album preview keeps a usable fallback before measurement', () => {
  assert.deepEqual(resolveYearAlbumPreviewLayout({
    containerWidth: 0,
    itemCount: 3
  }), {
    columnCount: 1,
    collapsedItemCount: 2,
    hasOverflow: true
  })
})
