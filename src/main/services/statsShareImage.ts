import { basename } from 'path'

export const STATS_SHARE_PNG_WIDTH = 1474
export const STATS_SHARE_PNG_HEIGHT = 1920
export const STATS_SHARE_PNG_MAX_BYTES = 20 * 1024 * 1024

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new Error('Invalid share-card PNG data.')
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000
    + bytes[offset + 1] * 0x10000
    + bytes[offset + 2] * 0x100
    + bytes[offset + 3]
  )
}

export function validateStatsSharePng(value: unknown): Uint8Array {
  const bytes = toBytes(value)
  if (bytes.byteLength < 33 || bytes.byteLength > STATS_SHARE_PNG_MAX_BYTES) {
    throw new Error('Share-card PNG has an invalid size.')
  }
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new Error('Share-card data is not a PNG.')
  }
  const ihdrLength = readUint32BigEndian(bytes, 8)
  const ihdrType = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
  if (ihdrLength !== 13 || ihdrType !== 'IHDR') {
    throw new Error('Share-card PNG is missing a valid header.')
  }
  const width = readUint32BigEndian(bytes, 16)
  const height = readUint32BigEndian(bytes, 20)
  if (width !== STATS_SHARE_PNG_WIDTH || height !== STATS_SHARE_PNG_HEIGHT) {
    throw new Error(`Share-card PNG must be ${STATS_SHARE_PNG_WIDTH}×${STATS_SHARE_PNG_HEIGHT}.`)
  }
  return bytes
}

export function normalizeStatsShareFileName(value: unknown, now: number = Date.now()): string {
  const fallbackDate = new Date(now).toISOString().slice(0, 10)
  const rawName = typeof value === 'string' ? basename(value.trim()) : ''
  const stem = rawName
    .replace(/\.png$/i, '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 110)
  return `${stem || `astra-listening-${fallbackDate}`}.png`
}
