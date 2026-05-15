import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  buildSourceLayout,
  getSourceChannelId,
  getSourceChannelLabel,
  isIdentityChannelMixMatrix,
  resolveChannelMixMatrix,
  type ChannelMixMatrix,
} from './sourceChannelLayout.ts'

const G = Number(Math.SQRT1_2.toFixed(6))
const L = 0.5

function compact(matrix: ChannelMixMatrix): Array<Array<[number, number]>> {
  return matrix.map((row) => (
    row.map((input) => [input.sourceIndex, Number(input.gain.toFixed(6))])
  ))
}

test('standard layouts use named speaker channels and preserve legacy generic labels without layout context', () => {
  assert.deepEqual(
    buildSourceLayout(6).map((channel) => channel.id),
    ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR']
  )
  assert.deepEqual(
    buildSourceLayout(8).map((channel) => channel.id),
    ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR']
  )
  assert.deepEqual(
    buildSourceLayout(7).map((channel) => channel.id),
    ['CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6', 'CH7']
  )
  assert.equal(getSourceChannelId(0), 'SRC1')
  assert.equal(getSourceChannelLabel(0), 'Decoded Channel 1')
  assert.equal(getSourceChannelId(2, 6), 'FC')
  assert.equal(getSourceChannelLabel(2, 6), 'Center')
})

test('stereo safe mode explicitly downmixes multichannel sources and omits LFE', () => {
  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 6,
      outputChannels: 8,
      multichannelEnabled: false,
    })),
    [
      [[0, 1], [2, G], [4, G]],
      [[1, 1], [2, G], [5, G]],
    ]
  )

  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 4,
      outputChannels: 2,
      multichannelEnabled: true,
    })),
    [
      [[0, 1], [2, G]],
      [[1, 1], [3, G]],
    ]
  )
})

test('automatic matrix handles multichannel reductions beyond stereo', () => {
  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 6,
      outputChannels: 4,
      multichannelEnabled: true,
    })),
    [
      [[0, 1], [2, G]],
      [[1, 1], [2, G]],
      [[4, 1]],
      [[5, 1]],
    ]
  )

  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 8,
      outputChannels: 6,
      multichannelEnabled: true,
    })),
    [
      [[0, 1]],
      [[1, 1]],
      [[2, 1]],
      [[3, 1]],
      [[4, G], [6, 1]],
      [[5, G], [7, 1]],
    ]
  )

  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 8,
      outputChannels: 4,
      multichannelEnabled: true,
    })),
    [
      [[0, 1], [2, G]],
      [[1, 1], [2, G]],
      [[4, G], [6, 1]],
      [[5, G], [7, 1]],
    ]
  )
})

test('LFE fold-down is opt-in when the output has no LFE channel', () => {
  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 6,
      outputChannels: 4,
      multichannelEnabled: true,
      includeLfeInDownmix: true,
    })),
    [
      [[0, 1], [2, G], [3, L]],
      [[1, 1], [2, G], [3, L]],
      [[4, 1]],
      [[5, 1]],
    ]
  )

  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 6,
      outputChannels: 2,
      multichannelEnabled: false,
      includeLfeInDownmix: true,
    })),
    [
      [[0, 1], [2, G], [3, L], [4, G]],
      [[1, 1], [2, G], [3, L], [5, G]],
    ]
  )

  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 6,
      outputChannels: 8,
      multichannelEnabled: true,
      includeLfeInDownmix: true,
    })),
    [
      [[0, 1]],
      [[1, 1]],
      [[2, 1]],
      [[3, 1]],
      [],
      [],
      [[4, 1]],
      [[5, 1]],
    ]
  )
})

test('automatic matrix preserves identity and silences unavailable extra outputs', () => {
  const identity = resolveChannelMixMatrix({
    sourceChannels: 6,
    outputChannels: 6,
    multichannelEnabled: true,
  })
  assert.equal(isIdentityChannelMixMatrix(identity, 6, 6), true)

  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 2,
      outputChannels: 6,
      multichannelEnabled: true,
    })),
    [
      [[0, 1]],
      [[1, 1]],
      [],
      [],
      [],
      [],
    ]
  )

  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 6,
      outputChannels: 8,
      multichannelEnabled: true,
    })),
    [
      [[0, 1]],
      [[1, 1]],
      [[2, 1]],
      [[3, 1]],
      [],
      [],
      [[4, 1]],
      [[5, 1]],
    ]
  )
})

test('manual matrix preserves exact remaps, mute, and invalid values', () => {
  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 6,
      outputChannels: 4,
      multichannelEnabled: true,
      manualRoutingMap: [4, 5, -1, 99],
    })),
    [
      [[4, 1]],
      [[5, 1]],
      [],
      [],
    ]
  )
})

test('manual 6 to 4 front layout folds unmapped center into front left and right', () => {
  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 6,
      outputChannels: 4,
      multichannelEnabled: true,
      manualRoutingMap: [0, 1, 4, 5],
    })),
    [
      [[0, 1], [2, G]],
      [[1, 1], [2, G]],
      [[4, 1]],
      [[5, 1]],
    ]
  )
})

test('manual LFE fold-down augments front rows only when enabled', () => {
  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 6,
      outputChannels: 4,
      multichannelEnabled: true,
      manualRoutingMap: [0, 1, 4, 5],
      includeLfeInDownmix: true,
    })),
    [
      [[0, 1], [2, G], [3, L]],
      [[1, 1], [2, G], [3, L]],
      [[4, 1]],
      [[5, 1]],
    ]
  )

  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 6,
      outputChannels: 4,
      multichannelEnabled: true,
      manualRoutingMap: [4, 5, -1, 99],
      includeLfeInDownmix: true,
    })),
    [
      [[4, 1]],
      [[5, 1]],
      [],
      [],
    ]
  )
})
