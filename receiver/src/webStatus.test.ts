import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveReceiverStatusLabel } from './webStatus.ts'

test('headless receiver distinguishes connected inactive zones from generic idle', () => {
  assert.equal(resolveReceiverStatusLabel({
    paired: true,
    connected: true,
    hostReachable: true,
    playbackEnabled: false
  }), 'Connected, not selected for playback')

  assert.equal(resolveReceiverStatusLabel({
    paired: true,
    connected: true,
    hostReachable: true,
    playbackEnabled: true
  }), 'Connected')
})
