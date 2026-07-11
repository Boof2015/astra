import 'reflect-metadata'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  webcrypto,
  X509Certificate as NodeX509Certificate,
  type KeyObject
} from 'crypto'
import * as x509 from '@peculiar/x509'
import { Agent } from 'undici'

export const PARALLAX_MAX_JSON_BYTES = 64 * 1024
export const PARALLAX_MAX_SSE_EVENT_BYTES = 64 * 1024
export const PARALLAX_MAX_AUDIO_PAYLOAD_BYTES = 4096 * 8 * Float32Array.BYTES_PER_ELEMENT

export interface ParallaxTlsIdentity {
  certificatePem: string
  privateKeyPem: string
  fingerprint256: string
}

export interface ParallaxEphemeralKeyPair {
  publicKey: string
  privateKey: KeyObject
}

export interface ParallaxPairingTranscript {
  version: 2
  pairingId: string
  hostEphemeralPublicKey: string
  sinkEphemeralPublicKey: string
  hostCertificateFingerprint: string
  hostParallaxEndpointUuid: string
  sinkParallaxEndpointUuid: string
  hostPort: number
}

export interface ParallaxSealedPayload {
  nonce: string
  ciphertext: string
  authTag: string
}

interface ParallaxReadableResponse {
  headers: { get(name: string): string | null }
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>
      cancel(reason?: unknown): Promise<void>
      releaseLock(): void
    }
  } | null
}

const PAIRING_INFO = Buffer.from('astra-parallax-v2-pairing', 'utf8')
const PAIRING_AAD_PREFIX = Buffer.from('astra-parallax-v2-confirm:', 'utf8')

function toPem(label: string, bytes: ArrayBuffer): string {
  const base64 = Buffer.from(bytes).toString('base64')
  const lines = base64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

export function normalizeParallaxFingerprint(value: string): string {
  return value.replace(/[^0-9a-f]/gi, '').toUpperCase()
}

export function parallaxCertificateFingerprint(certificatePem: string): string {
  const certificate = new NodeX509Certificate(certificatePem)
  return normalizeParallaxFingerprint(certificate.fingerprint256)
}

export function validateParallaxTlsIdentity(identity: ParallaxTlsIdentity): ParallaxTlsIdentity | null {
  try {
    const certificatePem = identity.certificatePem.trim()
    const privateKeyPem = identity.privateKeyPem.trim()
    if (!certificatePem || !privateKeyPem) return null
    const certificate = new NodeX509Certificate(certificatePem)
    const certificatePublicKey = certificate.publicKey.export({ type: 'spki', format: 'der' })
    const privateKeyPublicKey = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' })
    if (
      certificatePublicKey.byteLength !== privateKeyPublicKey.byteLength
      || !timingSafeEqual(certificatePublicKey, privateKeyPublicKey)
    ) return null
    const fingerprint256 = normalizeParallaxFingerprint(certificate.fingerprint256)
    if (fingerprint256 !== normalizeParallaxFingerprint(identity.fingerprint256)) return null
    return { certificatePem, privateKeyPem, fingerprint256 }
  } catch {
    return null
  }
}

export async function createParallaxTlsIdentity(commonName: string): Promise<ParallaxTlsIdentity> {
  x509.cryptoProvider.set(webcrypto as unknown as Crypto)
  const algorithm = {
    name: 'ECDSA',
    namedCurve: 'P-256',
    hash: 'SHA-256'
  } as const
  const keys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
  const x509Keys = keys as unknown as CryptoKeyPair
  const now = Date.now()
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString('hex'),
    name: `CN=${commonName.replace(/[,+="<>#;]/g, '_').slice(0, 64) || 'Astra Parallax'}`,
    notBefore: new Date(now - 24 * 60 * 60_000),
    notAfter: new Date(now + 10 * 365 * 24 * 60 * 60_000),
    signingAlgorithm: algorithm,
    keys: x509Keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyCertSign,
        true
      ),
      new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], true),
      await x509.SubjectKeyIdentifierExtension.create(x509Keys.publicKey)
    ]
  }, webcrypto as unknown as Crypto)
  const certificatePem = certificate.toString('pem')
  const privateKeyDer = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
  const privateKeyPem = toPem('PRIVATE KEY', privateKeyDer)
  return {
    certificatePem,
    privateKeyPem,
    fingerprint256: parallaxCertificateFingerprint(certificatePem)
  }
}

export function createParallaxEphemeralKeyPair(): ParallaxEphemeralKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey
  }
}

function transcriptBytes(transcript: ParallaxPairingTranscript): Buffer {
  return Buffer.from(JSON.stringify([
    transcript.version,
    transcript.pairingId,
    transcript.hostEphemeralPublicKey,
    transcript.sinkEphemeralPublicKey,
    normalizeParallaxFingerprint(transcript.hostCertificateFingerprint),
    transcript.hostParallaxEndpointUuid,
    transcript.sinkParallaxEndpointUuid,
    transcript.hostPort
  ]), 'utf8')
}

export function deriveParallaxPairingKey(
  privateKey: KeyObject,
  peerPublicKey: string,
  transcript: ParallaxPairingTranscript
): Buffer {
  const peer = Buffer.from(peerPublicKey, 'base64url')
  if (peer.byteLength < 32 || peer.byteLength > 128) {
    throw new Error('Invalid Parallax pairing public key.')
  }
  const publicKey = createPublicKey({
    key: peer,
    format: 'der',
    type: 'spki'
  })
  const sharedSecret = diffieHellman({ privateKey, publicKey })
  const salt = createHash('sha256').update(transcriptBytes(transcript)).digest()
  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, PAIRING_INFO, 32))
}

export function deriveParallaxPairingCode(key: Buffer, transcript: ParallaxPairingTranscript): string {
  const digest = createHash('sha256')
    .update(key)
    .update(Buffer.from('astra-parallax-v2-sas', 'utf8'))
    .update(transcriptBytes(transcript))
    .digest()
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

function pairingAad(transcript: ParallaxPairingTranscript): Buffer {
  return Buffer.concat([
    PAIRING_AAD_PREFIX,
    createHash('sha256').update(transcriptBytes(transcript)).digest()
  ])
}

export function sealParallaxPairingPayload(
  payload: unknown,
  key: Buffer,
  transcript: ParallaxPairingTranscript
): ParallaxSealedPayload {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(pairingAad(transcript))
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final()
  ])
  return {
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url')
  }
}

export function openParallaxPairingPayload<T>(
  sealed: ParallaxSealedPayload,
  key: Buffer,
  transcript: ParallaxPairingTranscript
): T {
  const nonce = Buffer.from(sealed.nonce, 'base64url')
  const ciphertext = Buffer.from(sealed.ciphertext, 'base64url')
  const authTag = Buffer.from(sealed.authTag, 'base64url')
  if (nonce.byteLength !== 12 || authTag.byteLength !== 16 || ciphertext.byteLength > PARALLAX_MAX_JSON_BYTES) {
    throw new Error('Invalid encrypted Parallax pairing payload.')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(pairingAad(transcript))
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(plaintext.toString('utf8')) as T
}

export function createParallaxPinnedDispatcher(
  certificatePem: string,
  expectedFingerprint: string
): Agent {
  const normalizedExpected = normalizeParallaxFingerprint(expectedFingerprint)
  if (!normalizedExpected) throw new Error('Parallax host certificate fingerprint is required.')
  return new Agent({
    connections: 3,
    pipelining: 1,
    connect: {
      ca: certificatePem,
      rejectUnauthorized: true,
      checkServerIdentity: (_hostname, certificate) => {
        const actual = createHash('sha256').update(certificate.raw).digest('hex').toUpperCase()
        const left = Buffer.from(actual, 'hex')
        const right = Buffer.from(normalizedExpected, 'hex')
        if (left.byteLength !== right.byteLength || !timingSafeEqual(left, right)) {
          return new Error('Parallax host certificate does not match the pinned identity.')
        }
        return undefined
      }
    }
  })
}

export async function readBoundedBytesResponse(response: ParallaxReadableResponse, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Parallax response limit is invalid.')
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('Parallax response is too large.')
  }
  if (!response.body) throw new Error('Parallax response has no body.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel('Parallax response is too large.')
        throw new Error('Parallax response is too large.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

export async function readBoundedJsonResponse<T>(response: ParallaxReadableResponse): Promise<T> {
  const body = (await readBoundedBytesResponse(response, PARALLAX_MAX_JSON_BYTES)).toString('utf8')
  if (!body.trim()) return null as T
  return JSON.parse(body) as T
}
