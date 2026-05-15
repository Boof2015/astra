import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  buildSourceLayout,
  canUseStereoAmbientUpmix,
  getSourceChannelId,
  getSourceChannelLabel,
  isIdentityChannelMixMatrix,
  resolveChannelMixMatrix,
  resolveStereoAmbientUpmixPlan,
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

test('stereo ambient upmix activation is standard-mode opt-in only', () => {
  const base = {
    sourceChannels: 2,
    outputChannels: 6,
    multichannelEnabled: true,
    standardMode: true,
    stereoUpmixMode: 'ambient' as const,
    manualRoutingMap: null,
  }

  assert.equal(canUseStereoAmbientUpmix(base), true)
  assert.equal(canUseStereoAmbientUpmix({ ...base, standardMode: false }), false)
  assert.equal(canUseStereoAmbientUpmix({ ...base, stereoUpmixMode: 'off' }), false)
  assert.equal(canUseStereoAmbientUpmix({ ...base, multichannelEnabled: false }), false)
  assert.equal(canUseStereoAmbientUpmix({ ...base, sourceChannels: 6 }), false)
  assert.equal(canUseStereoAmbientUpmix({ ...base, outputChannels: 2 }), false)
  assert.equal(canUseStereoAmbientUpmix({ ...base, outputChannels: 3 }), false)
})

test('stereo ambient upmix keeps fronts direct and generates only rear ambience', () => {
  assert.deepEqual(
    resolveStereoAmbientUpmixPlan(4).routes.map((route) => [route.outputId, route.kind]),
    [
      ['FL', 'direct'],
      ['FR', 'direct'],
      ['SL', 'ambience'],
      ['SR', 'ambience'],
    ]
  )

  assert.deepEqual(
    resolveStereoAmbientUpmixPlan(6).routes.map((route) => [route.outputId, route.kind]),
    [
      ['FL', 'direct'],
      ['FR', 'direct'],
      ['SL', 'ambience'],
      ['SR', 'ambience'],
    ]
  )

  assert.deepEqual(
    resolveStereoAmbientUpmixPlan(8).routes.map((route) => [route.outputId, route.kind]),
    [
      ['FL', 'direct'],
      ['FR', 'direct'],
      ['BL', 'ambience'],
      ['BR', 'ambience'],
      ['SL', 'ambience'],
      ['SR', 'ambience'],
    ]
  )

  assert.equal(
    resolveStereoAmbientUpmixPlan(6).routes.some((route) => route.outputId === 'FC' || route.outputId === 'LFE'),
    false
  )

  const sideLeftRoute = resolveStereoAmbientUpmixPlan(6).routes.find((route) => route.outputId === 'SL')
  assert.deepEqual(
    sideLeftRoute?.inputs.map((input) => [input.sourceIndex, input.gain]),
    [[0, 0.25], [1, -0.25]]
  )
  assert.equal(sideLeftRoute?.highpassHz, 300)
  assert.equal(sideLeftRoute?.lowpassHz, 8000)
  assert.equal(sideLeftRoute?.delaySeconds, 0.012)
  assert.deepEqual(sideLeftRoute?.allpassFrequenciesHz, [420, 1700, 4300])

  const sideRightRoute = resolveStereoAmbientUpmixPlan(6).routes.find((route) => route.outputId === 'SR')
  assert.deepEqual(
    sideRightRoute?.inputs.map((input) => [input.sourceIndex, input.gain]),
    [[0, -0.25], [1, 0.25]]
  )
  assert.deepEqual(sideRightRoute?.allpassFrequenciesHz, [380, 1900, 4700])
})

test('stereo ambient upmix rear routes cancel centered/mono content', () => {
  for (const channelCount of [4, 6, 8]) {
    const plan = resolveStereoAmbientUpmixPlan(channelCount)
    for (const route of plan.routes) {
      if (route.kind !== 'ambience') continue
      const sum = route.inputs.reduce((total, input) => total + input.gain, 0)
      assert.ok(
        Math.abs(sum) < 1e-9,
        `Route ${route.outputId} at ${channelCount}ch should sum to 0, got ${sum}`
      )
    }
  }
})

test('stereo ambient upmix decorrelates rear pairs via distinct all-pass cascades', () => {
  const sideLeft = resolveStereoAmbientUpmixPlan(6).routes.find((route) => route.outputId === 'SL')
  const sideRight = resolveStereoAmbientUpmixPlan(6).routes.find((route) => route.outputId === 'SR')
  assert.ok(sideLeft && sideRight, 'expected SL and SR routes')
  assert.notDeepEqual(sideLeft.allpassFrequenciesHz, sideRight.allpassFrequenciesHz)
  assert.ok(sideLeft.allpassFrequenciesHz.length > 0, 'expected non-empty all-pass cascade on SL')

  const backLeft = resolveStereoAmbientUpmixPlan(8).routes.find((route) => route.outputId === 'BL')
  const backRight = resolveStereoAmbientUpmixPlan(8).routes.find((route) => route.outputId === 'BR')
  assert.ok(backLeft && backRight, 'expected BL and BR routes')
  assert.notDeepEqual(backLeft.allpassFrequenciesHz, backRight.allpassFrequenciesHz)
  assert.notDeepEqual(backLeft.allpassFrequenciesHz, sideLeft.allpassFrequenciesHz)
})
