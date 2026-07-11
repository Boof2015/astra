import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createNetServer } from 'node:net'
import {
  createParallaxEphemeralKeyPair,
  createParallaxPinnedDispatcher,
  createParallaxTlsIdentity,
  deriveParallaxPairingCode,
  deriveParallaxPairingKey,
  openParallaxPairingPayload,
  readBoundedBytesResponse,
  readBoundedJsonResponse,
  sealParallaxPairingPayload,
  validateParallaxTlsIdentity,
  type ParallaxPairingTranscript
} from './parallaxSecurity.ts'
import { fetch as undiciFetch } from 'undici'

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function transcript(hostPublicKey: string, sinkPublicKey: string): ParallaxPairingTranscript {
  return {
    version: 2,
    pairingId: 'pairing-id',
    hostEphemeralPublicKey: hostPublicKey,
    sinkEphemeralPublicKey: sinkPublicKey,
    hostCertificateFingerprint: 'AA'.repeat(32),
    hostParallaxEndpointUuid: 'host-uuid',
    sinkParallaxEndpointUuid: 'sink-uuid',
    hostPort: 38403
  }
}

test('Parallax v2 derives the same security code and encryption key on both endpoints', () => {
  const host = createParallaxEphemeralKeyPair()
  const sink = createParallaxEphemeralKeyPair()
  const pairingTranscript = transcript(host.publicKey, sink.publicKey)
  const hostKey = deriveParallaxPairingKey(host.privateKey, sink.publicKey, pairingTranscript)
  const sinkKey = deriveParallaxPairingKey(sink.privateKey, host.publicKey, pairingTranscript)
  assert.deepEqual(hostKey, sinkKey)
  assert.equal(
    deriveParallaxPairingCode(hostKey, pairingTranscript),
    deriveParallaxPairingCode(sinkKey, pairingTranscript)
  )

  const sealed = sealParallaxPairingPayload({ sinkId: 'sink', token: 'secret-token' }, hostKey, pairingTranscript)
  assert.equal(JSON.stringify(sealed).includes('secret-token'), false)
  assert.deepEqual(
    openParallaxPairingPayload(sealed, sinkKey, pairingTranscript),
    { sinkId: 'sink', token: 'secret-token' }
  )
})

test('Parallax v2 substituted pairing keys produce different displayed codes', () => {
  const host = createParallaxEphemeralKeyPair()
  const sink = createParallaxEphemeralKeyPair()
  const attackerForHost = createParallaxEphemeralKeyPair()
  const attackerForSink = createParallaxEphemeralKeyPair()
  const hostTranscript = transcript(host.publicKey, attackerForHost.publicKey)
  const sinkTranscript = transcript(attackerForSink.publicKey, sink.publicKey)
  const hostKey = deriveParallaxPairingKey(host.privateKey, attackerForHost.publicKey, hostTranscript)
  const sinkKey = deriveParallaxPairingKey(sink.privateKey, attackerForSink.publicKey, sinkTranscript)
  assert.notEqual(
    deriveParallaxPairingCode(hostKey, hostTranscript),
    deriveParallaxPairingCode(sinkKey, sinkTranscript)
  )
})

test('Parallax TLS identity validation rejects a certificate paired with the wrong private key', async () => {
  const first = await createParallaxTlsIdentity('First Host')
  const second = await createParallaxTlsIdentity('Second Host')
  assert.equal(validateParallaxTlsIdentity(first)?.fingerprint256, first.fingerprint256)
  assert.equal(validateParallaxTlsIdentity({ ...first, privateKeyPem: second.privateKeyPem }), null)
})

test('Parallax v2 rejects altered and replayed pairing payloads under a different transcript', () => {
  const host = createParallaxEphemeralKeyPair()
  const sink = createParallaxEphemeralKeyPair()
  const pairingTranscript = transcript(host.publicKey, sink.publicKey)
  const key = deriveParallaxPairingKey(host.privateKey, sink.publicKey, pairingTranscript)
  const sealed = sealParallaxPairingPayload({ ok: true }, key, pairingTranscript)
  const alteredCiphertext = Buffer.from(sealed.ciphertext, 'base64url')
  alteredCiphertext[0] ^= 0x01
  const altered = { ...sealed, ciphertext: alteredCiphertext.toString('base64url') }
  assert.throws(() => openParallaxPairingPayload(altered, key, pairingTranscript))
  assert.throws(() => openParallaxPairingPayload(
    sealed,
    key,
    { ...pairingTranscript, pairingId: 'different-pairing' }
  ))
})

test('Pinned Parallax HTTPS rejects the wrong certificate before sending Authorization', async () => {
  const expected = await createParallaxTlsIdentity('Expected Host')
  const impostor = await createParallaxTlsIdentity('Impostor Host')
  const port = await freePort()
  let receivedAuthorization = false
  const server = createHttpsServer({ key: impostor.privateKeyPem, cert: impostor.certificatePem }, (req, res) => {
    receivedAuthorization = Boolean(req.headers.authorization)
    res.end('{}')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const dispatcher = createParallaxPinnedDispatcher(expected.certificatePem, expected.fingerprint256)
  try {
    await assert.rejects(undiciFetch(`https://127.0.0.1:${port}/v1/parallax/join`, {
      headers: { Authorization: 'Bearer must-not-leak' },
      dispatcher
    }))
    assert.equal(receivedAuthorization, false)
  } finally {
    await dispatcher.close().catch(() => undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('Parallax bounded JSON reader rejects oversized peer responses', async () => {
  const response = new Response(JSON.stringify({ value: 'x'.repeat(70 * 1024) }), {
    headers: { 'Content-Type': 'application/json' }
  })
  await assert.rejects(readBoundedJsonResponse(response), /too large/i)
})

test('Parallax bounded byte reader stops oversized binary responses while streaming', async () => {
  const response = new Response(new Uint8Array(1025))
  await assert.rejects(readBoundedBytesResponse(response, 1024), /too large/i)
})
