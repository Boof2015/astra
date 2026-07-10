import { strict as assert } from 'node:assert'
import test from 'node:test'
import { buildSpeakerLayout } from './sourceChannelLayout.ts'
import {
  buildSpatialSpeakerMessage,
  buildVirtualSpeakerLayout,
  isSpatialSampleRateSupported,
  isVirtualSpeakerLfe,
  normalizeSpatialLayoutPresetId,
  normalizeSpatialMode,
  normalizeVirtualSpeakers,
  resolveRoutingTargetChannelCount,
  uiDegreesToAmbisonicRadians,
  SPATIAL_LAYOUT_PRESETS,
  type SpatialLayoutPresetId,
} from './virtualSpeakerLayout.ts'

test('every preset matches buildSpeakerLayout channel order for its count', () => {
  // 5.1.2 is intentionally exempt: its 8 speakers are not the standard
  // 8-channel layout (7.1), so the render bus feeds routing via explicit
  // outputChannelIds instead of the count-derived layout.
  for (const { id } of SPATIAL_LAYOUT_PRESETS) {
    if (id === 'custom' || id === '5.1.2') continue
    const speakers = buildVirtualSpeakerLayout(id, null)
    const expected = buildSpeakerLayout(speakers.length).map((channel) => channel.id)
    assert.deepEqual(
      speakers.map((sp) => sp.sourceChannel),
      expected,
      `preset ${id} must follow the standard ${speakers.length}-channel layout order`
    )
  }
  assert.deepEqual(
    buildVirtualSpeakerLayout('5.1.2', null).map((sp) => sp.sourceChannel),
    [...buildVirtualSpeakerLayout('5.1', null).map((sp) => sp.sourceChannel), 'TFL', 'TFR']
  )
})

test('preset angles are symmetric and fronts sit in front', () => {
  for (const { id } of SPATIAL_LAYOUT_PRESETS) {
    if (id === 'custom') continue
    const speakers = buildVirtualSpeakerLayout(id, null)
    const byChannel = new Map(speakers.map((sp) => [sp.sourceChannel, sp]))
    const pairs: Array<[string, string]> = [
      ['FL', 'FR'],
      ['SL', 'SR'],
      ['BL', 'BR'],
      ['TFL', 'TFR'],
      ['TBL', 'TBR'],
    ]
    for (const [left, right] of pairs) {
      const l = byChannel.get(left)
      const r = byChannel.get(right)
      if (!l || !r) continue
      assert.equal(l.azimuth, -r.azimuth, `${id}: ${left}/${right} must mirror`)
      assert.ok(l.azimuth < 0, `${id}: ${left} must be on the left (negative degrees)`)
      assert.equal(l.elevation, r.elevation, `${id}: ${left}/${right} elevation must match`)
    }
    const fc = byChannel.get('FC')
    if (fc) assert.equal(fc.azimuth, 0)
    for (const sp of speakers) {
      const isHeight = sp.sourceChannel.startsWith('T')
      assert.equal(sp.elevation, isHeight ? 45 : 0, `${id}: only heights are elevated`)
      assert.equal(sp.gain, 1)
    }
  }
})

test('uiDegreesToAmbisonicRadians flips sign (UI clockwise -> lib counterclockwise)', () => {
  // FL at UI -30° (left) must become a POSITIVE libspatialaudio azimuth.
  assert.ok(uiDegreesToAmbisonicRadians(-30) > 0)
  assert.ok(Math.abs(uiDegreesToAmbisonicRadians(-30) - Math.PI / 6) < 1e-9)
  assert.ok(uiDegreesToAmbisonicRadians(30) < 0)
  assert.equal(uiDegreesToAmbisonicRadians(0), -0)
  // Wrapping: 190° normalizes to -170°.
  assert.ok(Math.abs(uiDegreesToAmbisonicRadians(190) - (170 * Math.PI) / 180) < 1e-9)
})

test('buildSpatialSpeakerMessage marks LFE and converts angles', () => {
  const message = buildSpatialSpeakerMessage(buildVirtualSpeakerLayout('5.1', null))
  assert.equal(message.length, 6)
  assert.equal(message.filter((sp) => sp.isLfe).length, 1)
  assert.equal(message[3].isLfe, true) // LFE is index 3 in the 6ch layout
  assert.ok(message[0].azimuthRad > 0) // FL (UI -30°) -> positive radians
  assert.ok(message[1].azimuthRad < 0) // FR
  assert.equal(message[2].azimuthRad, -0) // FC
  for (const sp of message) {
    assert.equal(sp.elevationRad, 0)
    assert.equal(sp.gain, 1)
  }
})

test('normalizeVirtualSpeakers round-trips presets and rejects junk', () => {
  const original = buildVirtualSpeakerLayout('7.1', null)
  const parsed = normalizeVirtualSpeakers(JSON.parse(JSON.stringify(original)))
  assert.deepEqual(parsed, original)

  assert.equal(normalizeVirtualSpeakers(null), null)
  assert.equal(normalizeVirtualSpeakers([]), null)
  assert.equal(normalizeVirtualSpeakers('5.1'), null)
  assert.equal(normalizeVirtualSpeakers([{ azimuth: 30 }]), null)
  // Duplicate source channels are invalid.
  assert.equal(
    normalizeVirtualSpeakers([
      { sourceChannel: 'FL', azimuth: -30 },
      { sourceChannel: 'FL', azimuth: 30 },
    ]),
    null
  )
  // Out-of-range values clamp instead of failing.
  const clamped = normalizeVirtualSpeakers([
    { sourceChannel: 'FL', azimuth: 500, elevation: 200, gain: 99 },
  ])
  assert.ok(clamped)
  assert.equal(clamped[0].azimuth, 140)
  assert.equal(clamped[0].elevation, 90)
  assert.equal(clamped[0].gain, 2)
  assert.equal(clamped[0].id, 'vs-FL')
  // Elevation clamps to the MIT HRTF's measured floor (-40°), not -90°.
  const low = normalizeVirtualSpeakers([{ sourceChannel: 'FL', azimuth: 0, elevation: -200 }])
  assert.ok(low)
  assert.equal(low[0].elevation, -40)
})

test('buildSpatialSpeakerMessage converts elevation and clamps to the HRTF range', () => {
  const message = buildSpatialSpeakerMessage([
    { id: 'vs-TFL', sourceChannel: 'TFL', azimuth: -45, elevation: 45, gain: 1 },
    { id: 'vs-FL', sourceChannel: 'FL', azimuth: -30, elevation: -50, gain: 1 },
  ])
  assert.ok(Math.abs(message[0].elevationRad - Math.PI / 4) < 1e-9)
  assert.ok(Math.abs(message[1].elevationRad - (-40 * Math.PI) / 180) < 1e-9)
})

test('custom layout falls back to the default preset without valid speakers', () => {
  const fallback = buildVirtualSpeakerLayout('custom', null)
  assert.deepEqual(fallback, buildVirtualSpeakerLayout('5.1', null))
  const custom = normalizeVirtualSpeakers([
    { sourceChannel: 'FL', azimuth: -60 },
    { sourceChannel: 'FR', azimuth: 60 },
  ])
  assert.ok(custom)
  assert.deepEqual(buildVirtualSpeakerLayout('custom', custom), custom)
})

test('normalizers coerce unknown persisted values', () => {
  assert.equal(normalizeSpatialMode('binaural'), 'binaural')
  assert.equal(normalizeSpatialMode('anything'), 'off')
  assert.equal(normalizeSpatialMode(undefined), 'off')
  assert.equal(normalizeSpatialLayoutPresetId('7.1'), '7.1')
  assert.equal(normalizeSpatialLayoutPresetId('nope'), '5.1')
  assert.equal(normalizeSpatialLayoutPresetId(undefined) satisfies SpatialLayoutPresetId, '5.1')
})

test('isSpatialSampleRateSupported matches the MIT HRTF rates', () => {
  for (const rate of [44100, 48000, 88200, 96000]) {
    assert.equal(isSpatialSampleRateSupported(rate), true)
  }
  for (const rate of [22050, 32000, 176400, 192000]) {
    assert.equal(isSpatialSampleRateSupported(rate), false)
  }
})

test('resolveRoutingTargetChannelCount truth table', () => {
  const base = {
    multichannelEnabled: false,
    binauralActive: false,
    virtualSpeakerCount: 6,
    maxDestinationChannels: 2,
    manualMapLength: 0,
    hasSourceChannels: true,
  }

  // Binaural wins regardless of physical channels / manual map / multichannel.
  assert.equal(resolveRoutingTargetChannelCount({ ...base, binauralActive: true }), 6)
  assert.equal(
    resolveRoutingTargetChannelCount({
      ...base,
      binauralActive: true,
      multichannelEnabled: true,
      manualMapLength: 4,
      maxDestinationChannels: 8,
    }),
    6
  )
  assert.equal(
    resolveRoutingTargetChannelCount({ ...base, binauralActive: true, virtualSpeakerCount: 2 }),
    2
  )
  assert.equal(
    resolveRoutingTargetChannelCount({ ...base, binauralActive: true, virtualSpeakerCount: 99 }),
    12
  )

  // Direct mode mirrors the existing engine behavior exactly.
  assert.equal(resolveRoutingTargetChannelCount({ ...base, maxDestinationChannels: 8 }), 2)
  assert.equal(
    resolveRoutingTargetChannelCount({
      ...base,
      multichannelEnabled: true,
      maxDestinationChannels: 8,
    }),
    8
  )
  assert.equal(
    resolveRoutingTargetChannelCount({
      ...base,
      multichannelEnabled: true,
      maxDestinationChannels: 8,
      manualMapLength: 6,
    }),
    6
  )
  assert.equal(
    resolveRoutingTargetChannelCount({
      ...base,
      multichannelEnabled: true,
      maxDestinationChannels: 8,
      hasSourceChannels: false,
    }),
    2
  )
  // Manual map larger than the device clamps to the device.
  assert.equal(
    resolveRoutingTargetChannelCount({
      ...base,
      multichannelEnabled: true,
      maxDestinationChannels: 6,
      manualMapLength: 8,
    }),
    6
  )
})

test('isVirtualSpeakerLfe flags only LFE', () => {
  assert.equal(isVirtualSpeakerLfe({ sourceChannel: 'LFE' }), true)
  assert.equal(isVirtualSpeakerLfe({ sourceChannel: 'FL' }), false)
})
