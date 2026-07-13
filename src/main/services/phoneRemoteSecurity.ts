import {
  createCipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject
} from 'crypto'
import {
  createParallaxTlsIdentity,
  normalizeParallaxFingerprint,
  validateParallaxTlsIdentity,
  type ParallaxTlsIdentity
} from './parallaxSecurity'

export type PhoneRemoteTlsIdentity = ParallaxTlsIdentity

export const PHONE_REMOTE_TOKEN_ROTATE_AFTER_MS = 90 * 24 * 60 * 60_000
export const PHONE_REMOTE_TOKEN_ROTATE_REQUIRED_MS = 120 * 24 * 60 * 60_000
export const PHONE_REMOTE_PREVIOUS_TOKEN_GRACE_MS = 24 * 60 * 60_000
export const PHONE_REMOTE_DEVICE_INACTIVITY_MS = 365 * 24 * 60 * 60_000

const PAIRING_INFO = Buffer.from('astra-phone-remote-v3-pairing', 'utf8')
const PAIRING_AAD_PREFIX = Buffer.from('astra-phone-remote-v3-confirm:', 'utf8')

export interface PhoneRemotePairingTranscript {
  version: 3
  pairingId: string
  phoneEphemeralPublicKey: string
  desktopEphemeralPublicKey: string
  desktopCertificateFingerprint: string
  desktopEndpointUuid: string
  desktopPort: number
}

export interface PhoneRemoteEphemeralKeyPair {
  publicKey: string
  privateKey: KeyObject
}

export interface PhoneRemoteSealedPayload {
  nonce: string
  ciphertext: string
  authTag: string
}

export function normalizePhoneRemoteFingerprint(value: string): string {
  return normalizeParallaxFingerprint(value)
}

export async function createPhoneRemoteTlsIdentity(commonName: string): Promise<PhoneRemoteTlsIdentity> {
  return createParallaxTlsIdentity(commonName)
}

export function validatePhoneRemoteTlsIdentity(identity: PhoneRemoteTlsIdentity): PhoneRemoteTlsIdentity | null {
  return validateParallaxTlsIdentity(identity)
}

export function createPhoneRemoteEphemeralKeyPair(): PhoneRemoteEphemeralKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey
  }
}

function transcriptBytes(transcript: PhoneRemotePairingTranscript): Buffer {
  return Buffer.from(JSON.stringify([
    transcript.version,
    transcript.pairingId,
    transcript.phoneEphemeralPublicKey,
    transcript.desktopEphemeralPublicKey,
    normalizePhoneRemoteFingerprint(transcript.desktopCertificateFingerprint),
    transcript.desktopEndpointUuid,
    transcript.desktopPort
  ]), 'utf8')
}

export function derivePhoneRemotePairingKey(
  privateKey: KeyObject,
  peerPublicKey: string,
  transcript: PhoneRemotePairingTranscript
): Buffer {
  const encoded = Buffer.from(peerPublicKey, 'base64url')
  if (encoded.byteLength < 64 || encoded.byteLength > 256) {
    throw new Error('Invalid phone remote pairing public key.')
  }
  const publicKey = createPublicKey({ key: encoded, format: 'der', type: 'spki' })
  const sharedSecret = diffieHellman({ privateKey, publicKey })
  const salt = createHash('sha256').update(transcriptBytes(transcript)).digest()
  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, PAIRING_INFO, 32))
}

export function derivePhoneRemotePairingCode(
  key: Buffer,
  transcript: PhoneRemotePairingTranscript
): string {
  const digest = createHmac('sha256', key)
    .update('astra-phone-remote-v3-code')
    .update(transcriptBytes(transcript))
    .digest()
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

export function createPhoneRemotePairingProof(
  key: Buffer,
  transcript: PhoneRemotePairingTranscript
): string {
  return createHmac('sha256', key)
    .update('astra-phone-remote-v3-proof')
    .update(transcriptBytes(transcript))
    .digest('base64url')
}

export function verifyPhoneRemotePairingProof(
  supplied: string,
  key: Buffer,
  transcript: PhoneRemotePairingTranscript
): boolean {
  const expected = createPhoneRemotePairingProof(key, transcript)
  const left = Buffer.from(supplied)
  const right = Buffer.from(expected)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function pairingAad(transcript: PhoneRemotePairingTranscript): Buffer {
  return Buffer.concat([
    PAIRING_AAD_PREFIX,
    createHash('sha256').update(transcriptBytes(transcript)).digest()
  ])
}

export function sealPhoneRemotePairingPayload(
  payload: unknown,
  key: Buffer,
  transcript: PhoneRemotePairingTranscript
): PhoneRemoteSealedPayload {
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
