import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ParallaxPairingPrompt } from './ParallaxPairingPrompt.ts'

test('pairing approval prompt renders the web fallback and makes CEC optional', () => {
  const html = renderToStaticMarkup(createElement(ParallaxPairingPrompt, {
    sinkName: 'Living Room',
    submitting: true
  }))

  assert.equal(
    html,
    '<span>Code matched. Approve on the Parallax display, or open '
      + '<strong>http://parallax.local/</strong> on another device. CEC is optional.</span>'
  )
})

test('pairing prompt retains the sink-specific PIN instruction before submission', () => {
  const html = renderToStaticMarkup(createElement(ParallaxPairingPrompt, {
    sinkName: 'Living Room',
    submitting: false
  }))

  assert.equal(
    html,
    '<span>Enter the 6-digit security code shown on <strong>Living Room</strong>.</span>'
  )
})
