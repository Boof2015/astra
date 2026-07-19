import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAlsaCards } from './alsaDevices.ts'

// Verbatim /proc/asound/cards from a Pi 5 (two HDMI ports + the headphone jack).
const PI5_CARDS = ` 0 [vc4hdmi0       ]: vc4-hdmi - vc4-hdmi-0
                      vc4-hdmi-0
 1 [vc4hdmi1       ]: vc4-hdmi - vc4-hdmi-1
                      vc4-hdmi-1
 2 [Headphones     ]: bcm2835_headpho - bcm2835 Headphones
                      bcm2835 Headphones
`

test('parses Pi 5 cards into plughw ids matching the installer', () => {
  assert.deepEqual(parseAlsaCards(PI5_CARDS), [
    { id: 'plughw:vc4hdmi0,0', label: 'vc4hdmi0 — vc4-hdmi - vc4-hdmi-0' },
    { id: 'plughw:vc4hdmi1,0', label: 'vc4hdmi1 — vc4-hdmi - vc4-hdmi-1' },
    { id: 'plughw:Headphones,0', label: 'Headphones — bcm2835_headpho - bcm2835 Headphones' }
  ])
})

test('ignores continuation lines, blank input, and cardless systems', () => {
  assert.deepEqual(parseAlsaCards(''), [])
  assert.deepEqual(parseAlsaCards('--- no soundcards ---\n'), [])
})
