import { createHmac, timingSafeEqual } from 'crypto'
import type { CompanionApiTargetType } from '../../types/companionApi'

const REF_PREFIX = 'astra'
const SIGNATURE_BYTES = 18
const MAX_REFERENCE_LENGTH = 2_048
const MAX_PAYLOAD_BYTES = 1_024

export interface CompanionApiReference {
  type: CompanionApiTargetType
  key: string
}

function encodePart(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function decodePart(value: string): string | null {
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.length === 0 || bytes.length > MAX_PAYLOAD_BYTES) return null
    const decoded = bytes.toString('utf8')
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) return null
    return decoded
  } catch {
    return null
  }
}

export class CompanionApiReferenceSigner {
  private readonly secret: Buffer

  constructor(secret: string | Buffer) {
    this.secret = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(secret, 'base64url')
    if (this.secret.length < 24) {
      throw new Error('Companion API reference secret must contain at least 24 bytes.')
    }
  }

  create(type: CompanionApiTargetType, key: string | number): string {
    const normalizedKey = String(key)
    if (!normalizedKey || Buffer.byteLength(normalizedKey, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new Error('Companion API reference key is invalid.')
    }
    const payload = encodePart(normalizedKey)
    const unsigned = `${REF_PREFIX}.${type}.${payload}`
    const signature = createHmac('sha256', this.secret)
      .update(unsigned)
      .digest()
      .subarray(0, SIGNATURE_BYTES)
      .toString('base64url')
    return `${unsigned}.${signature}`
  }

  parse(value: unknown, expectedType?: CompanionApiTargetType): CompanionApiReference | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REFERENCE_LENGTH) return null
    const parts = value.split('.')
    if (parts.length !== 4 || parts[0] !== REF_PREFIX) return null
    const type = parts[1]
    if (type !== 'track' && type !== 'album' && type !== 'artist' && type !== 'playlist') return null
    if (expectedType && type !== expectedType) return null

    const suppliedSignature = Buffer.from(parts[3], 'base64url')
    if (suppliedSignature.length !== SIGNATURE_BYTES) return null
    if (suppliedSignature.toString('base64url') !== parts[3]) return null
    const unsigned = `${parts[0]}.${type}.${parts[2]}`
    const expectedSignature = createHmac('sha256', this.secret)
      .update(unsigned)
      .digest()
      .subarray(0, SIGNATURE_BYTES)
    if (!timingSafeEqual(suppliedSignature, expectedSignature)) return null

    const key = decodePart(parts[2])
    if (!key) return null
    return { type, key }
  }
}
