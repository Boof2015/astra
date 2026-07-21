import { basename } from 'path'

export const SIGNAL_SHARE_PNG_HEIGHT = 360
export const SIGNAL_SHARE_PNG_WIDTHS = [1188, 1476, 1764] as const
export const SIGNAL_SHARE_PNG_MAX_BYTES = 8 * 1024 * 1024

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new Error('Invalid Signal PNG data.')
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000
    + bytes[offset + 1] * 0x10000
    + bytes[offset + 2] * 0x100
    + bytes[offset + 3]
  )
}

export function validateSignalSharePng(value: unknown): Uint8Array {
  const bytes = toBytes(value)
  if (bytes.byteLength < 33 || bytes.byteLength > SIGNAL_SHARE_PNG_MAX_BYTES) {
    throw new Error('Signal PNG has an invalid size.')
  }
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new Error('Signal data is not a PNG.')
  }
  const ihdrLength = readUint32BigEndian(bytes, 8)
  const ihdrType = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
  if (ihdrLength !== 13 || ihdrType !== 'IHDR') {
    throw new Error('Signal PNG is missing a valid header.')
  }

  const width = readUint32BigEndian(bytes, 16)
  const height = readUint32BigEndian(bytes, 20)
  if (!SIGNAL_SHARE_PNG_WIDTHS.includes(width as typeof SIGNAL_SHARE_PNG_WIDTHS[number]) || height !== SIGNAL_SHARE_PNG_HEIGHT) {
    throw new Error('Signal PNG has unexpected dimensions.')
  }
  return bytes
}

export function normalizeSignalShareFileName(value: unknown): string {
  const rawName = typeof value === 'string' ? basename(value.trim()) : ''
  const stem = rawName
    .replace(/\.png$/i, '')
    .replace(/\.[^.]+$/, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 110)
  return `${stem || 'astra-signal'}.png`
}
