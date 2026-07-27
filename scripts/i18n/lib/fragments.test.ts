import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error - plain ESM toolchain module, intentionally untyped.
import { buildTransMessage, isBrokenSentence } from './fragments.mjs'

const message = (key: string, wrap?: string) => ({ namespace: 'settings', key, wrap })
const literal = (value: string) => ({ literal: value })
const dynamic = (value: string) => ({ dynamic: value })

const TEXTS: Record<string, string> = {
  appends: 'Astra appends',
  get: '/api/get',
  and: 'and',
  search: '/api/search',
  tail: '. HTTP is supported for local mirrors.',
  tracks: 'Tracks',
  albums: 'Albums',
  artists: 'Artists',
  first: 'Playback stopped.',
  second: 'Check your output device.',
  move: 'Move',
  file: 'file',
  trash: 'to Trash?',
}
const textOf = (part: { key: string }) => TEXTS[part.key]

test('a sentence woven through inline markup is broken', () => {
  assert.equal(
    isBrokenSentence([
      message('appends'),
      literal(' '),
      message('get', 'code'),
      literal(' '),
      message('and'),
      literal(' '),
      message('search', 'code'),
      message('tail'),
    ]),
    true
  )
})

test('a row of sibling labels is not broken', () => {
  // "Tracks Albums Artists" in a nav bar are three independent strings that happen to be adjacent.
  assert.equal(
    isBrokenSentence([message('tracks'), literal(' '), message('albums'), literal(' '), message('artists')], textOf),
    false
  )
})

test('a value interpolated mid-sentence makes it broken', () => {
  assert.equal(
    isBrokenSentence([message('move'), literal(' '), dynamic('count'), literal(' '), message('file'), literal(' '), message('trash')]),
    true
  )
})

test('literal punctuation between fragments makes it broken', () => {
  assert.equal(isBrokenSentence([message('first'), literal(' — '), message('second')], textOf), true)
})

test('a single message is never broken', () => {
  assert.equal(isBrokenSentence([literal('x'), message('tracks'), literal('y')], textOf), false)
})

test('markup outside the span does not count', () => {
  // A wrapper before the first message or after the last is decoration around the run, not
  // something woven through it.
  assert.equal(
    isBrokenSentence([message('tracks', 'strong'), literal(' '), message('albums'), literal(' '), message('artists', 'strong')], textOf),
    false
  )
})

test('buildTransMessage numbers markup by child position', () => {
  const parts = [
    message('appends'),
    literal(' '),
    message('get', 'code'),
    literal(' '),
    message('and'),
    literal(' '),
    message('search', 'code'),
    message('tail'),
  ]
  assert.equal(
    buildTransMessage(parts, textOf),
    'Astra appends <1>/api/get</1> and <3>/api/search</3>. HTTP is supported for local mirrors.'
  )
})

test('buildTransMessage turns interpolated values into named placeholders', () => {
  const parts = [message('move'), literal(' '), dynamic('count'), literal(' '), message('file'), literal(' '), message('trash')]
  assert.equal(buildTransMessage(parts, textOf), 'Move {{count}} file to Trash?')
})

test('buildTransMessage collapses the spacing the extractor left behind', () => {
  const parts = [message('appends'), literal('   '), message('and'), literal(' '), message('tail')]
  assert.equal(buildTransMessage(parts, textOf), 'Astra appends and. HTTP is supported for local mirrors.')
})

test('an unnamed value still gets a usable placeholder name', () => {
  assert.equal(
    buildTransMessage([message('move'), literal(' '), dynamic(''), literal(' '), message('trash')], textOf),
    'Move {{value}} to Trash?'
  )
})

test('a lowercase continuation fragment is broken even with nothing woven between', () => {
  // "Playback stopped." followed by "and could not resume" is one sentence split in two; a
  // fragment that starts lowercase is never a standalone label.
  assert.equal(
    isBrokenSentence([message('first'), literal(' '), message('and')], textOf),
    true
  )
})
