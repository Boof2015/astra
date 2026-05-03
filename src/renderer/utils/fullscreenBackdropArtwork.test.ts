import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FULLSCREEN_BACKDROP_INLINE_ARTWORK_MAX_CHARS,
  getFullscreenBackdropArtworkCandidates,
  shouldUseInlineArtworkAsFullscreenBackdrop,
} from './fullscreenBackdropArtwork.ts'
import type { ArtworkRequestOptions } from '../stores/libraryStore.ts'

test('fullscreen backdrop uses bounded card artwork for hash-backed tracks', async () => {
  const seenRequests: Array<{ hash: string | null; options?: ArtworkRequestOptions }> = []

  const candidates = await getFullscreenBackdropArtworkCandidates({
    artworkHash: 'cover-hash',
    artworkData: `data:image/jpeg;base64,${'x'.repeat(FULLSCREEN_BACKDROP_INLINE_ARTWORK_MAX_CHARS + 1)}`,
  }, async (hash, options) => {
    seenRequests.push({ hash, options })
    return 'blob:card-artwork'
  })

  assert.deepEqual(candidates, ['blob:card-artwork'])
  assert.deepEqual(seenRequests, [{
    hash: 'cover-hash',
    options: { variant: 'card' },
  }])
})

test('fullscreen backdrop skips oversized inline artwork', async () => {
  const candidates = await getFullscreenBackdropArtworkCandidates({
    artworkData: `data:image/png;base64,${'x'.repeat(FULLSCREEN_BACKDROP_INLINE_ARTWORK_MAX_CHARS + 1)}`,
  }, async () => {
    throw new Error('No hash artwork should be requested')
  })

  assert.deepEqual(candidates, [])
})

test('fullscreen backdrop allows small inline artwork', () => {
  assert.equal(shouldUseInlineArtworkAsFullscreenBackdrop('data:image/png;base64,small'), true)
  assert.equal(shouldUseInlineArtworkAsFullscreenBackdrop(''), false)
  assert.equal(shouldUseInlineArtworkAsFullscreenBackdrop(null), false)
})
