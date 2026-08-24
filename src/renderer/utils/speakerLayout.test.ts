import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  SPEAKER_LAYOUT_PRESETS,
  buildSpeakerHardwareRoutingPlan,
  createDefaultDeviceSpeakerProfile,
  getSpeakerLayoutDefinition,
  normalizeDeviceSpeakerProfile,
  normalizeSourceSpeakerRoutingMap,
  resolveDeviceSpeakerProfile,
  resolveDirectSpeakerIds,
  setSpeakerHardwareOutput,
  transitionDeviceSpeakerLayout,
} from './speakerLayout.ts'

test('physical speaker presets use deterministic semantic role order', () => {
  assert.deepEqual(
    SPEAKER_LAYOUT_PRESETS.map((preset) => [preset.id, preset.speakers]),
    [
      ['mono', ['M']],
      ['stereo', ['FL', 'FR']],
      ['quad', ['FL', 'FR', 'SL', 'SR']],
      ['5.0', ['FL', 'FR', 'FC', 'SL', 'SR']],
      ['5.1', ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR']],
      ['5.1.2', ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR', 'TFL', 'TFR']],
      ['7.1', ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR']],
      ['7.1.4', ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR', 'TBL', 'TBR']],
    ]
  )
})

test('device keys restore independent saved profiles', () => {
  const profiles = {
    focusrite: normalizeDeviceSpeakerProfile({
      layoutId: 'quad',
      outputMap: { FL: 0, FR: 1, SL: 16, SR: 17 },
    }, 26),
    headphones: createDefaultDeviceSpeakerProfile(2),
  }

  assert.equal(resolveDeviceSpeakerProfile(profiles, 'focusrite', 26).layoutId, 'quad')
  assert.deepEqual(
    resolveDeviceSpeakerProfile(profiles, 'focusrite', 26).outputMap,
    { FL: 0, FR: 1, SL: 16, SR: 17 }
  )
  assert.equal(resolveDeviceSpeakerProfile(profiles, 'headphones', 2).layoutId, 'stereo')
  assert.equal(resolveDeviceSpeakerProfile(profiles, 'new-mono-device', 1).layoutId, 'mono')
})

test('unconfigured devices default safely without inferring their maximum width', () => {
  assert.deepEqual(createDefaultDeviceSpeakerProfile(26), {
    layoutId: 'stereo',
    outputMap: { FL: 0, FR: 1 },
    source: 'manual',
  })
  assert.deepEqual(createDefaultDeviceSpeakerProfile(1), {
    layoutId: 'mono',
    outputMap: { M: 0 },
    source: 'manual',
  })
})

test('profile normalization drops duplicate and invalid hardware outputs', () => {
  assert.deepEqual(normalizeDeviceSpeakerProfile({
    layoutId: 'quad',
    outputMap: { FL: 0, FR: 0, SL: 16, SR: 99, FC: 2 },
  }, 26), {
    layoutId: 'quad',
    outputMap: { FL: 0, SL: 16 },
    source: 'manual',
  })
})

test('layout transitions preserve shared roles and fill new roles independently', () => {
  const quad = normalizeDeviceSpeakerProfile({
    layoutId: 'quad',
    outputMap: { FL: 0, FR: 1, SL: 16, SR: 17 },
  }, 26)
  const fiveOne = transitionDeviceSpeakerLayout(quad, '5.1', 26)

  assert.deepEqual(fiveOne.outputMap, {
    FL: 0,
    FR: 1,
    FC: 2,
    LFE: 3,
    SL: 16,
    SR: 17,
  })
})

test('hardware mutations are unique and never rewrite unrelated assignments', () => {
  const quad = transitionDeviceSpeakerLayout(createDefaultDeviceSpeakerProfile(26), 'quad', 26)
  const moved = setSpeakerHardwareOutput(quad, 'SL', 4, 26)
  assert.deepEqual(moved.outputMap, { FL: 0, FR: 1, SL: 4, SR: 3 })

  const rejectedDuplicate = setSpeakerHardwareOutput(moved, 'SL', 1, 26)
  assert.equal(rejectedDuplicate, moved)
})

test('hardware routing uses logical width separately from sparse physical width', () => {
  const profile = normalizeDeviceSpeakerProfile({
    layoutId: 'quad',
    outputMap: { FL: 0, FR: 1, SL: 16, SR: 17 },
  }, 26)
  const plan = buildSpeakerHardwareRoutingPlan(profile)

  assert.equal(getSpeakerLayoutDefinition(profile.layoutId).speakers.length, 4)
  assert.equal(plan.hardwareBusWidth, 18)
  assert.deepEqual(plan.logicalToHardware, [0, 1, 16, 17])
  assert.deepEqual(
    plan.hardwareToLogical.map((logical, output) => logical == null ? null : [output, logical]),
    [[0, 0], [1, 1], ...Array.from({ length: 14 }, () => null), [16, 2], [17, 3]]
  )
})

test('stereo-safe mode uses logical fronts rather than device capability', () => {
  const quad = transitionDeviceSpeakerLayout(createDefaultDeviceSpeakerProfile(26), 'quad', 26)
  assert.deepEqual(resolveDirectSpeakerIds(quad, false), ['FL', 'FR'])
  assert.deepEqual(resolveDirectSpeakerIds(quad, true), ['FL', 'FR', 'SL', 'SR'])
  assert.deepEqual(resolveDirectSpeakerIds(createDefaultDeviceSpeakerProfile(1), false), ['M'])
})

test('source routing normalization permits duplicated semantic source choices', () => {
  assert.deepEqual(normalizeSourceSpeakerRoutingMap({
    FL: { kind: 'source', sourceChannelId: 'FC' },
    FR: { kind: 'source', sourceChannelId: 'FC' },
    SL: { kind: 'mute' },
    nope: { kind: 'mute' },
  }), {
    FL: { kind: 'source', sourceChannelId: 'FC' },
    FR: { kind: 'source', sourceChannelId: 'FC' },
    SL: { kind: 'mute' },
  })
})
