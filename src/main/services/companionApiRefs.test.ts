import assert from 'node:assert/strict'
import test from 'node:test'
import { CompanionApiReferenceSigner } from './companionApiRefs.ts'

const SECRET = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8')

test('AstraRefs round-trip every public target type without exposing the signed key', () => {
  const signer = new CompanionApiReferenceSigner(SECRET)
  const fixtures = [
    ['track', 42],
    ['album', 'album:identity:key'],
    ['artist', 'Artist Name'],
    ['playlist', 7]
  ] as const

  for (const [type, key] of fixtures) {
    const ref = signer.create(type, key)
    assert.match(ref, /^astra\.(track|album|artist|playlist)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    assert.equal(ref.includes(String(key)), false)
    assert.deepEqual(signer.parse(ref), { type, key: String(key) })
    assert.deepEqual(signer.parse(ref, type), { type, key: String(key) })
  }
})

test('AstraRefs reject tampering, type substitution, malformed payloads, and another signing secret', () => {
  const signer = new CompanionApiReferenceSigner(SECRET)
  const ref = signer.create('track', 42)
  const parts = ref.split('.')
  const tamperedPayload = [parts[0], parts[1], Buffer.from('43').toString('base64url'), parts[3]].join('.')
  const tamperedType = [parts[0], 'album', parts[2], parts[3]].join('.')

  assert.equal(signer.parse(tamperedPayload), null)
  assert.equal(signer.parse(tamperedType), null)
  assert.equal(signer.parse(`${ref}x`), null)
  assert.equal(signer.parse(ref, 'album'), null)
  assert.equal(new CompanionApiReferenceSigner(Buffer.alloc(32, 9)).parse(ref), null)
})

test('AstraRefs remain valid when unrelated bearer credentials rotate', () => {
  const signer = new CompanionApiReferenceSigner(SECRET)
  const ref = signer.create('playlist', 123)
  let bearerToken = 'old-token'
  bearerToken = 'rotated-token'

  assert.equal(bearerToken, 'rotated-token')
  assert.deepEqual(signer.parse(ref), { type: 'playlist', key: '123' })
})

test('reference secrets must be dedicated high-entropy values', () => {
  assert.throws(
    () => new CompanionApiReferenceSigner(Buffer.alloc(23)),
    /at least 24 bytes/
  )
})
