/**
 * Contract for "the output device refused this track's format in exclusive mode".
 *
 * The preload throws this and the renderer catches it across the contextBridge, which
 * strips custom properties off Error objects. So the machine-readable part rides along in
 * the message on its own line: the first line stays human-readable for logs, and the
 * tagged tail is what `parseBitPerfectFormatError` reads back.
 */

const ERROR_TAG = 'ASTRA_DEVICE_FORMAT_UNSUPPORTED'

export interface BitPerfectFormatFailure {
  /** Friendly device name, when the backend could resolve one. */
  deviceLabel: string | null
  /** What Astra asked the device for. */
  sampleRate: number | null
  channels: number | null
  sampleFormat: string | null
  /** The backend's own explanation, including what the device does accept. */
  message: string
}

export function createBitPerfectFormatError(failure: BitPerfectFormatFailure): Error {
  const payload = JSON.stringify(failure)
  return new Error(`${failure.message}\n${ERROR_TAG}:${payload}`)
}

export function parseBitPerfectFormatError(error: unknown): BitPerfectFormatFailure | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null
  if (!message) return null

  const tagIndex = message.indexOf(`${ERROR_TAG}:`)
  if (tagIndex === -1) return null

  try {
    const parsed: unknown = JSON.parse(message.slice(tagIndex + ERROR_TAG.length + 1))
    if (!parsed || typeof parsed !== 'object') return null
    const candidate = parsed as Partial<BitPerfectFormatFailure>
    return {
      deviceLabel: typeof candidate.deviceLabel === 'string' ? candidate.deviceLabel : null,
      sampleRate: typeof candidate.sampleRate === 'number' ? candidate.sampleRate : null,
      channels: typeof candidate.channels === 'number' ? candidate.channels : null,
      sampleFormat: typeof candidate.sampleFormat === 'string' ? candidate.sampleFormat : null,
      message: typeof candidate.message === 'string' ? candidate.message : message.slice(0, tagIndex).trim()
    }
  } catch {
    return null
  }
}

/** The human-readable half, with the machine-readable tail stripped off. */
export function stripBitPerfectFormatTag(message: string): string {
  const tagIndex = message.indexOf(`${ERROR_TAG}:`)
  return tagIndex === -1 ? message : message.slice(0, tagIndex).trim()
}
