import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getLibraryTabTransitionScopeClasses,
  resolveLibraryTabTransitionDirection
} from './libraryTabMotion.ts'

test('resolveLibraryTabTransitionDirection follows library tab order', () => {
  assert.equal(resolveLibraryTabTransitionDirection('tracks', 'albums'), 'forward')
  assert.equal(resolveLibraryTabTransitionDirection('artists', 'genres'), 'forward')
  assert.equal(resolveLibraryTabTransitionDirection('genres', 'years'), 'forward')
  assert.equal(resolveLibraryTabTransitionDirection('folders', 'years'), 'backward')
  assert.equal(resolveLibraryTabTransitionDirection('albums', 'tracks'), 'backward')
  assert.equal(resolveLibraryTabTransitionDirection('albums', 'albums'), null)
  assert.equal(resolveLibraryTabTransitionDirection(null, 'albums'), null)
  assert.equal(resolveLibraryTabTransitionDirection('albums', undefined), null)
})

test('getLibraryTabTransitionScopeClasses includes the scoped direction class', () => {
  assert.deepEqual(
    getLibraryTabTransitionScopeClasses('tracks', 'albums'),
    ['library-tab-transition', 'library-tab-transition-forward']
  )
  assert.deepEqual(
    getLibraryTabTransitionScopeClasses('albums', 'tracks'),
    ['library-tab-transition', 'library-tab-transition-backward']
  )
  assert.deepEqual(
    getLibraryTabTransitionScopeClasses('albums', 'albums'),
    ['library-tab-transition']
  )
})
