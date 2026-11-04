import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

// Render the actual TSX components, without a browser/Electron dependency in the
// regular test runner. The browser fixture also checks effects after remount.
const output = buildSync({
  stdin: { resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'tsx', contents: `
    import React from 'react'
    import { renderToStaticMarkup } from 'react-dom/server'
    import AlbumArtwork from './AlbumArtwork'
    import PlaylistCover from '../playlists/PlaylistCover'
    import { buildArtworkProtocolUrl } from '../../stores/libraryStore'
    import { rememberDisplayedArtwork, forgetDisplayedArtwork } from '../../utils/displayedArtwork'
    export function album(warm, variant = 'card') {
      const url = buildArtworkProtocolUrl('known-cover.jpg', 'card')
      if (warm) rememberDisplayedArtwork(url); else forgetDisplayedArtwork(url)
      return renderToStaticMarkup(<AlbumArtwork hash="known-cover.jpg" variant={variant} />)
    }
    export function playlist(favorites) {
      return renderToStaticMarkup(<PlaylistCover hash="known-cover.jpg" name="List" isFavorites={favorites} />)
    }
  ` },
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external'
}).outputFiles[0].text
const compiled = { exports: {} as { album: (warm: boolean, variant?: string) => string; playlist: (favorites: boolean) => string } }
new Function('require', 'module', 'exports', output)(createRequire(import.meta.url), compiled, compiled.exports)

test('returning to a known album renders its image immediately without a placeholder or preload effect', () => {
  assert.match(compiled.exports.album(false), /album-artwork-placeholder/)
  for (let visit = 0; visit < 5; visit++) {
    const markup = compiled.exports.album(true)
    assert.match(markup, /<img /)
    assert.doesNotMatch(markup, /album-artwork-placeholder/)
  }
  assert.match(compiled.exports.album(true, 'full'), /album-artwork-placeholder/, 'another size is not assumed decoded')
  assert.match(compiled.exports.album(false), /album-artwork-placeholder/, 'failed images can forget their display hint')
})

test('playlist covers render their stable image URL on the first render and keep the favorites icon', () => {
  assert.match(compiled.exports.playlist(false), /<img /)
  assert.doesNotMatch(compiled.exports.playlist(true), /<img /)
})
