import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeSignalLink } from '@boof2015/astra-signal'
import {
  buildSignalShareModel,
  signalInputFromTarget
} from './signalShare'
import { getSignalShareCanvasSize } from './signalShareCanvas'

test('builds a private web resolver URL from rounded, database-free metadata', () => {
  const model = buildSignalShareModel({
    artist: 'ナナツカゼ',
    title: 'Replay!',
    duration: 213.6
  })

  assert.deepEqual(model.input, {
    artist: 'ナナツカゼ',
    title: 'Replay!',
    durationSec: 214
  })
  assert.equal(model.webUrl, `https://astramusic.dev/signal/#${model.nativeLink}`)
  assert.deepEqual(decodeSignalLink(model.nativeLink), {
    version: 3,
    type: 'metadata',
    artist: 'ナナツカゼ',
    title: 'Replay!',
    durationSec: 214
  })
  assert.equal(model.metadataWasShortened, false)
})

test('preserves ASCII case and punctuation and normalizes invalid duration', () => {
  const model = buildSignalShareModel({
    artist: 'N!GHT',
    title: '#iwannadance',
    duration: Number.NaN
  })

  assert.equal(model.layout.payload.artist, 'N!GHT')
  assert.equal(model.layout.payload.title, '#iwannadance')
  assert.equal(model.layout.payload.durationSec, 0)
  assert.equal(signalInputFromTarget({ artist: 'A', title: 'B', duration: Infinity }).durationSec, 0)
})

test('reports deterministic title shortening from the encoded payload', () => {
  const title = '五月猫'.repeat(100)
  const model = buildSignalShareModel({ artist: 'ナナツカゼ', title, duration: 207 })

  assert.equal(model.layout.tier, 'large')
  assert.equal(model.metadataWasShortened, true)
  assert.equal(model.layout.payload.artist, 'ナナツカゼ')
  assert.equal(title.startsWith(model.layout.payload.title), true)
  assert.ok(model.layout.payload.title.length > 0)
})

test('uses the canonical branded dimensions for all Signal tiers', () => {
  const small = buildSignalShareModel({ artist: 'A', title: 'B', duration: 1 })
  const medium = buildSignalShareModel({ artist: 'x', title: 'a'.repeat(19), duration: 1 })
  const large = buildSignalShareModel({ artist: 'x', title: 'a'.repeat(35), duration: 1 })

  assert.equal(small.layout.tier, 'small')
  assert.equal(medium.layout.tier, 'medium')
  assert.equal(large.layout.tier, 'large')
  assert.deepEqual(getSignalShareCanvasSize(small.layout), { width: 1188, height: 360 })
  assert.deepEqual(getSignalShareCanvasSize(medium.layout), { width: 1476, height: 360 })
  assert.deepEqual(getSignalShareCanvasSize(large.layout), { width: 1764, height: 360 })
})
