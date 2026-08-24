import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  applySourceSpeakerOverridesToStereoAmbientUpmixPlan,
  buildSourceLayout,
  canUseStereoAdaptiveUpmix,
  canUseStereoAmbientUpmix,
  getSourceChannelId,
  getSourceChannelLabel,
  isIdentityChannelMixMatrix,
  normalizeStereoUpmixMode,
  resolveChannelMixMatrix,
  resolveStereoAmbientUpmixPlan,
  resolveStereoAdaptiveUpmixPlan,
  type ChannelMixMatrix,
} from './sourceChannelLayout.ts'

const G = Number(Math.SQRT1_2.toFixed(6))
const L = 0.5
const SIDE_AMBIENCE_GAIN = Number((10 ** (-2 / 20)).toFixed(6))
const SIDE_AMBIENCE_CROSSFEED_GAIN = Number(((10 ** (-2 / 20)) * 0.5).toFixed(6))
const BACK_AMBIENCE_GAIN = Number((10 ** (-2 / 20)).toFixed(6))
const BACK_AMBIENCE_CROSSFEED_GAIN = Number(((10 ** (-2 / 20)) * 0.5).toFixed(6))

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

test('explicit Mono and 5.0 layouts preserve their semantic behavior', () => {
  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 2,
      outputChannels: 1,
      multichannelEnabled: true,
      outputChannelIds: ['M'],
    })),
    [[[0, 0.5], [1, 0.5]]]
  )

  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 6,
      outputChannels: 5,
      multichannelEnabled: true,
      outputChannelIds: ['FL', 'FR', 'FC', 'SL', 'SR'],
    })),
    [
      [[0, 1]],
      [[1, 1]],
      [[2, 1]],
      [[4, 1]],
      [[5, 1]],
    ]
  )

  assert.ok(isIdentityChannelMixMatrix(
    resolveChannelMixMatrix({
      sourceChannels: 2,
      outputChannels: 2,
      multichannelEnabled: true,
      outputChannelIds: ['FL', 'FR'],
    }),
    2,
    2
  ))
})

test('7.1.4 source layout is named and folds heights down to flat layouts', () => {
  assert.deepEqual(
    buildSourceLayout(12).map((channel) => channel.id),
    ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR', 'TBL', 'TBR']
  )
  // 10ch stays generic: ambiguous between 7.1.2 and 5.1.4.
  assert.equal(buildSourceLayout(10)[0].id, 'CH1')

  // 12 -> 12 is identity.
  assert.ok(isIdentityChannelMixMatrix(
    resolveChannelMixMatrix({ sourceChannels: 12, outputChannels: 12, multichannelEnabled: true }),
    12,
    12
  ))

  // 12 -> 7.1: top-fronts fold into the fronts, top-backs into the backs.
  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 12,
      outputChannels: 8,
      multichannelEnabled: true,
    })),
    [
      [[0, 1], [8, G]],
      [[1, 1], [9, G]],
      [[2, 1]],
      [[3, 1]],
      [[4, 1], [10, G]],
      [[5, 1], [11, G]],
      [[6, 1]],
      [[7, 1]],
    ]
  )

  // 12 -> 5.1: backs and top-backs land on the sides.
  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 12,
      outputChannels: 6,
      multichannelEnabled: true,
    })),
    [
      [[0, 1], [8, G]],
      [[1, 1], [9, G]],
      [[2, 1]],
      [[3, 1]],
      [[4, G], [6, 1], [10, G]],
      [[5, G], [7, 1], [11, G]],
    ]
  )

  // 12 -> stereo safe mode: everything folds to the fronts, LFE omitted.
  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 12,
      outputChannels: 8,
      multichannelEnabled: false,
    })),
    [
      [[0, 1], [2, G], [4, G], [6, G], [8, G], [10, G]],
      [[1, 1], [2, G], [5, G], [7, G], [9, G], [11, G]],
    ]
  )
})

const FIVE_ONE_TWO_IDS = ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR', 'TFL', 'TFR'] as const

test('explicit outputChannelIds override the count-derived layout', () => {
  // 7.1 source -> 8-wide 5.1.2 bus: matching counts must NOT shortcut to
  // identity (that would dump SL/SR into the height slots). Backs fold to
  // the sides; heights stay silent.
  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 8,
      outputChannels: 8,
      multichannelEnabled: true,
      outputChannelIds: FIVE_ONE_TWO_IDS,
    })),
    [
      [[0, 1]],
      [[1, 1]],
      [[2, 1]],
      [[3, 1]],
      [[4, G], [6, 1]],
      [[5, G], [7, 1]],
      [],
      [],
    ]
  )

  // Ids that do match the source elementwise keep the identity shortcut.
  assert.ok(isIdentityChannelMixMatrix(
    resolveChannelMixMatrix({
      sourceChannels: 12,
      outputChannels: 12,
      multichannelEnabled: true,
      outputChannelIds: ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR', 'TBL', 'TBR'],
    }),
    12,
    12
  ))

  // A length mismatch ignores the ids instead of misaligning rows.
  assert.ok(isIdentityChannelMixMatrix(
    resolveChannelMixMatrix({
      sourceChannels: 6,
      outputChannels: 6,
      multichannelEnabled: true,
      outputChannelIds: FIVE_ONE_TWO_IDS,
    }),
    6,
    6
  ))
})

test('stereo ambient upmix honors explicit output layouts', () => {
  // 5.1.2 bus: ambience lands on SL/SR at indices 4/5 (not the 7.1 indices
  // 6/7, which are the height slots here); no back routes, heights silent.
  const plan = resolveStereoAmbientUpmixPlan(8, FIVE_ONE_TWO_IDS)
  assert.deepEqual(
    plan.routes.map((route) => [route.outputId, route.outputIndex, route.kind]),
    [
      ['FL', 0, 'direct'],
      ['FR', 1, 'direct'],
      ['SL', 4, 'ambience'],
      ['SR', 5, 'ambience'],
    ]
  )

  assert.equal(
    canUseStereoAmbientUpmix({
      sourceChannels: 2,
      outputChannels: 8,
      multichannelEnabled: true,
      standardMode: true,
      stereoUpmixMode: 'ambient',
      outputChannelIds: FIVE_ONE_TWO_IDS,
    }),
    true
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

test('semantic source-to-speaker overrides replace only selected logical rows', () => {
  assert.deepEqual(
    compact(resolveChannelMixMatrix({
      sourceChannels: 6,
      outputChannels: 4,
      outputChannelIds: ['FL', 'FR', 'SL', 'SR'],
      multichannelEnabled: true,
      sourceSpeakerRoutingMap: {
        FL: { kind: 'source', sourceChannelId: 'FC' },
        FR: { kind: 'source', sourceChannelId: 'FC' },
        SL: { kind: 'mute' },
      },
    })),
    [
      [[2, 1]],
      [[2, 1]],
      [],
      [[5, 1]],
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

test('adaptive mode persists while unknown saved values normalize to off', () => {
  assert.equal(normalizeStereoUpmixMode('adaptive'), 'adaptive')
  assert.equal(normalizeStereoUpmixMode('ambient'), 'ambient')
  assert.equal(normalizeStereoUpmixMode('future-mode'), 'off')
  assert.equal(normalizeStereoUpmixMode(null), 'off')
})

test('adaptive activation requires stereo, Standard, and a usable surround bed', () => {
  const base = {
    sourceChannels: 2,
    outputChannels: 6,
    multichannelEnabled: true,
    standardMode: true,
    stereoUpmixMode: 'adaptive' as const,
    outputChannelIds: ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'],
  }
  assert.equal(canUseStereoAdaptiveUpmix(base), true)
  assert.equal(canUseStereoAdaptiveUpmix({ ...base, standardMode: false }), false)
  assert.equal(canUseStereoAdaptiveUpmix({ ...base, sourceChannels: 6 }), false)
  assert.equal(canUseStereoAdaptiveUpmix({ ...base, stereoUpmixMode: 'ambient' }), false)
  assert.equal(canUseStereoAdaptiveUpmix({
    ...base,
    outputChannels: 2,
    outputChannelIds: ['FL', 'FR'],
  }), false)
  assert.equal(canUseStereoAdaptiveUpmix({
    ...base,
    outputChannels: 4,
    outputChannelIds: ['FL', 'FR', 'TFL', 'TFR'],
  }), false)
})

test('adaptive plans classify semantic fronts, surrounds, and silent roles', () => {
  assert.deepEqual(
    resolveStereoAdaptiveUpmixPlan(8, ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'])
      .routes.map((route) => [route.outputId, route.kind]),
    [
      ['FL', 'front'],
      ['FR', 'front'],
      ['FC', 'front'],
      ['LFE', 'unused'],
      ['BL', 'surround'],
      ['BR', 'surround'],
      ['SL', 'surround'],
      ['SR', 'surround'],
    ]
  )
  assert.deepEqual(
    resolveStereoAdaptiveUpmixPlan(8, ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR', 'TFL', 'TFR'])
      .routes.map((route) => [route.outputId, route.kind]),
    [
      ['FL', 'front'], ['FR', 'front'], ['FC', 'front'], ['LFE', 'unused'],
      ['SL', 'surround'], ['SR', 'surround'], ['TFL', 'unused'], ['TFR', 'unused'],
    ]
  )
})

test('adaptive routing supports quad, 5.0, 5.1, and 7.1 beds', () => {
  const layouts = [
    ['FL', 'FR', 'SL', 'SR'],
    ['FL', 'FR', 'FC', 'SL', 'SR'],
    ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'],
    ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'],
  ]
  for (const outputChannelIds of layouts) {
    const plan = resolveStereoAdaptiveUpmixPlan(outputChannelIds.length, outputChannelIds)
    assert.equal(plan.routes.length, outputChannelIds.length)
    assert.deepEqual(plan.routes.map((route) => route.outputId), outputChannelIds)
    assert.equal(
      plan.routes.find((route) => route.outputId === 'LFE')?.kind,
      outputChannelIds.includes('LFE') ? 'unused' : undefined
    )
    assert.equal(canUseStereoAdaptiveUpmix({
      sourceChannels: 2,
      outputChannels: outputChannelIds.length,
      multichannelEnabled: true,
      standardMode: true,
      stereoUpmixMode: 'adaptive',
      outputChannelIds,
    }), true)
  }
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
    sideLeftRoute?.inputs.map((input) => [input.sourceIndex, Number(input.gain.toFixed(6))]),
    [[0, SIDE_AMBIENCE_GAIN], [1, -SIDE_AMBIENCE_CROSSFEED_GAIN]]
  )
  assert.equal(sideLeftRoute?.highpassHz, 300)
  assert.equal(sideLeftRoute?.lowpassHz, 8000)
  assert.equal(sideLeftRoute?.delaySeconds, 0.012)
  assert.deepEqual(sideLeftRoute?.allpassFrequenciesHz, [420, 1700, 4300])

  const sideRightRoute = resolveStereoAmbientUpmixPlan(6).routes.find((route) => route.outputId === 'SR')
  assert.deepEqual(
    sideRightRoute?.inputs.map((input) => [input.sourceIndex, Number(input.gain.toFixed(6))]),
    [[0, -SIDE_AMBIENCE_CROSSFEED_GAIN], [1, SIDE_AMBIENCE_GAIN]]
  )
  assert.deepEqual(sideRightRoute?.allpassFrequenciesHz, [380, 1900, 4700])

  const backLeftRoute = resolveStereoAmbientUpmixPlan(8).routes.find((route) => route.outputId === 'BL')
  assert.deepEqual(
    backLeftRoute?.inputs.map((input) => [input.sourceIndex, Number(input.gain.toFixed(6))]),
    [[0, BACK_AMBIENCE_GAIN], [1, -BACK_AMBIENCE_CROSSFEED_GAIN]]
  )
})

test('speaker overrides replace only their ambient-upmix rows', () => {
  const plan = applySourceSpeakerOverridesToStereoAmbientUpmixPlan(
    resolveStereoAmbientUpmixPlan(6),
    {
      FL: { kind: 'source', sourceChannelId: 'FR' },
      FC: { kind: 'source', sourceChannelId: 'FL' },
      SL: { kind: 'mute' },
    },
    ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR']
  )

  assert.deepEqual(
    plan.routes.map((route) => [route.outputId, route.kind]),
    [['FL', 'direct'], ['FR', 'direct'], ['FC', 'direct'], ['SR', 'ambience']]
  )
  assert.deepEqual(plan.routes[0]?.inputs, [{ sourceIndex: 1, gain: 1 }])
  assert.deepEqual(plan.routes[2]?.inputs, [{ sourceIndex: 0, gain: 1 }])
  assert.equal(plan.routes.some((route) => route.outputId === 'SL'), false)
  assert.deepEqual(
    plan.routes[3]?.inputs.map((input) => [input.sourceIndex, Number(input.gain.toFixed(6))]),
    [[0, -SIDE_AMBIENCE_CROSSFEED_GAIN], [1, SIDE_AMBIENCE_GAIN]]
  )
})

test('stereo ambient upmix surround routes keep a low-level centered bed', () => {
  for (const channelCount of [4, 6, 8]) {
    const plan = resolveStereoAmbientUpmixPlan(channelCount)
    for (const route of plan.routes) {
      if (route.kind !== 'ambience') continue
      const sum = route.inputs.reduce((total, input) => total + input.gain, 0)
      assert.ok(
        sum > 0,
        `Route ${route.outputId} at ${channelCount}ch should keep centered content, got ${sum}`
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
