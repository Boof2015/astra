import { strict as assert } from 'node:assert'
import test from 'node:test'
import { buildVirtualSpeakerLayout } from './virtualSpeakerLayout.ts'
import { resolveSpeakerStageUsage, type SpeakerStageUsageState } from './speakerStageUsage.ts'

function ids(preset: '5.1' | '7.1.4'): string[] {
  return buildVirtualSpeakerLayout(preset, null).map((speaker) => speaker.sourceChannel)
}

function routedIds(outputIds: string[], states: SpeakerStageUsageState[]): string[] {
  return outputIds.filter((_, index) => states[index] === 'routed')
}

test('stereo routes only to the virtual fronts when ambient upmix is off', () => {
  const outputIds = ids('5.1')
  const states = resolveSpeakerStageUsage({
    sourceChannels: 2,
    outputChannelIds: outputIds,
    rendererActive: true,
    standardMode: true,
    stereoUpmixMode: 'off',
  })

  assert.deepEqual(routedIds(outputIds, states), ['FL', 'FR'])
  assert.deepEqual(states, ['routed', 'routed', 'unused', 'unused', 'unused', 'unused'])
})

test('stereo ambient upmix marks only generated front and surround routes', () => {
  const outputIds = ids('5.1')
  const states = resolveSpeakerStageUsage({
    sourceChannels: 2,
    outputChannelIds: outputIds,
    rendererActive: true,
    standardMode: true,
    stereoUpmixMode: 'ambient',
  })

  assert.deepEqual(routedIds(outputIds, states), ['FL', 'FR', 'SL', 'SR'])
  assert.equal(states[2], 'unused') // FC
  assert.equal(states[3], 'unused') // LFE
})

test('matching multichannel sources route every virtual speaker', () => {
  for (const preset of ['5.1', '7.1.4'] as const) {
    const outputIds = ids(preset)
    const states = resolveSpeakerStageUsage({
      sourceChannels: outputIds.length,
      outputChannelIds: outputIds,
      rendererActive: true,
      standardMode: true,
      stereoUpmixMode: 'off',
    })

    assert.deepEqual(states, outputIds.map(() => 'routed'), preset)
  }
})

test('larger sources mark every smaller output that receives a fold-down route', () => {
  const outputIds = ids('5.1')
  const states = resolveSpeakerStageUsage({
    sourceChannels: 8,
    outputChannelIds: outputIds,
    rendererActive: true,
    standardMode: true,
    stereoUpmixMode: 'off',
  })

  assert.deepEqual(states, outputIds.map(() => 'routed'))
})

test('missing tracks and unavailable renderers leave the virtual room inactive', () => {
  const outputIds = ids('5.1')
  const base = {
    outputChannelIds: outputIds,
    standardMode: true,
    stereoUpmixMode: 'off' as const,
  }

  assert.deepEqual(
    resolveSpeakerStageUsage({ ...base, sourceChannels: null, rendererActive: true }),
    outputIds.map(() => 'inactive')
  )
  assert.deepEqual(
    resolveSpeakerStageUsage({ ...base, sourceChannels: 2, rendererActive: false }),
    outputIds.map(() => 'inactive')
  )
})
