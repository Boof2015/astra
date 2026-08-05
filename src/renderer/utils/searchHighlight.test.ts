import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { highlightSearchMatch } from './searchHighlight.ts'

function renderHighlight(text: string, query: string, className?: string): string {
  return renderToStaticMarkup(createElement(
    Fragment,
    null,
    highlightSearchMatch(text, query, className)
  ))
}

test('highlights literal matches as a contiguous range', () => {
  assert.equal(
    renderHighlight('The Radio Dept.', 'radio'),
    'The <mark class="search-highlight">Radio</mark> Dept.'
  )
})

test('highlights the accepted initialism and compact match indices', () => {
  assert.equal(
    renderHighlight('Red Hot Chili Peppers', 'rhc', 'hit'),
    '<mark class="hit">R</mark>ed <mark class="hit">H</mark>ot <mark class="hit">C</mark>hili Peppers'
  )
  assert.equal(
    renderHighlight('Radiohead', 'rdio', 'hit'),
    '<mark class="hit">R</mark>a<mark class="hit">dio</mark>head'
  )
})

test('does not partially highlight rejected or incomplete matches', () => {
  assert.equal(renderHighlight('Radiohead', 'rhd'), 'Radiohead')
  assert.equal(renderHighlight('Radiohead', 'radioz'), 'Radiohead')
  assert.equal(renderHighlight('Kid A', 'radio'), 'Kid A')
})
