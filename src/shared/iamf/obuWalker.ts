// Lightweight IAMF OBU stream walker — no decoding. Used to (a) estimate
// duration at library-scan time without spawning the wasm decoder and (b)
// pre-size the planar output arrays before a full decode (iamfWasmDriver).
//
// IAMF OBU header (per spec / libiamf IAMF_OBU_split): byte 0 packs
// obu_type(5, MSB-first) | redundant(1) | trimming(1) | extension(1), then an
// unsigned LEB128 payload size counting everything after the size field.
// When flagged, the payload begins with trim_end/trim_start LEB128s, then an
// extension_header_size LEB128 + that many bytes, then the payload proper.

export const IAMF_OBU_CODEC_CONFIG = 0
export const IAMF_OBU_TEMPORAL_DELIMITER = 4
export const IAMF_OBU_AUDIO_FRAME = 5
export const IAMF_OBU_AUDIO_FRAME_ID0 = 6
export const IAMF_OBU_AUDIO_FRAME_ID17 = 23
export const IAMF_OBU_SEQUENCE_HEADER = 31

export interface IamfStreamStats {
  /** Codec 4CC from the first codec config OBU: 'Opus' | 'fLaC' | 'ipcm' | 'mp4a'. */
  codecId: string
  samplesPerFrame: number
  /** Null when the codec config doesn't carry it (then assume the decoder's output rate). */
  sampleRate: number | null
  /** Temporal units = frames of the first-seen audio-frame OBU type. */
  temporalUnits: number
  /** samplesPerFrame × temporalUnits − trims seen on counted frames. */
  totalSamples: number
  durationSeconds: number | null
}

interface Leb128 { value: number; length: number }

function readLeb128(bytes: Uint8Array, offset: number): Leb128 | null {
  let value = 0
  for (let i = 0; i < 8; i++) {
    if (offset + i >= bytes.length) return null
    const byte = bytes[offset + i]
    // Beyond 2^53 the stream is hostile/corrupt; bail rather than lose precision.
    if (i === 7 && (byte & 0x80) !== 0) return null
    value += (byte & 0x7f) * 2 ** (7 * i)
    if ((byte & 0x80) === 0) return { value, length: i + 1 }
  }
  return null
}

export function isIamfObuStream(bytes: Uint8Array): boolean {
  if (bytes.length < 6) return false
  if (bytes[0] >> 3 !== IAMF_OBU_SEQUENCE_HEADER) return false
  const size = readLeb128(bytes, 1)
  if (!size) return false
  const p = 1 + size.length
  // Sequence header payload starts with the ia_code 4CC 'iamf'.
  return (
    bytes[p] === 0x69 && bytes[p + 1] === 0x61 && bytes[p + 2] === 0x6d && bytes[p + 3] === 0x66
  )
}

/**
 * Walks the whole OBU stream counting temporal units. Returns null when the
 * stream is not a parseable IAMF sequence. Cost is one pass over OBU headers
 * (payloads are skipped), so it is safe at scan time even for large files.
 */
export function collectIamfStreamStats(bytes: Uint8Array): IamfStreamStats | null {
  if (!isIamfObuStream(bytes)) return null

  let offset = 0
  let codecId: string | null = null
  let samplesPerFrame = 0
  let sampleRate: number | null = null
  let countedFrameType: number | null = null
  let temporalUnits = 0
  let trimmedSamples = 0

  while (offset + 2 <= bytes.length) {
    const head = bytes[offset]
    const type = head >> 3
    const trimming = (head & 0x02) !== 0
    const extension = (head & 0x01) !== 0
    const size = readLeb128(bytes, offset + 1)
    if (!size) break
    const payloadStart = offset + 1 + size.length
    const next = payloadStart + size.value
    if (next > bytes.length) break

    let p = payloadStart
    let trimEnd = 0
    let trimStart = 0
    if (trimming) {
      const te = readLeb128(bytes, p)
      if (!te) break
      p += te.length
      const ts = readLeb128(bytes, p)
      if (!ts) break
      p += ts.length
      trimEnd = te.value
      trimStart = ts.value
    }
    if (extension) {
      const ext = readLeb128(bytes, p)
      if (!ext) break
      p += ext.length + ext.value
    }

    if (type === IAMF_OBU_CODEC_CONFIG && codecId === null) {
      const id = readLeb128(bytes, p)
      if (!id) break
      let q = p + id.length
      if (q + 4 > next) break
      codecId = String.fromCharCode(bytes[q], bytes[q + 1], bytes[q + 2], bytes[q + 3])
      q += 4
      const spf = readLeb128(bytes, q)
      if (!spf) break
      samplesPerFrame = spf.value
      q += spf.length + 2 // + audio_roll_distance (s16)
      sampleRate = parseDecoderConfigSampleRate(codecId, bytes, q, next)
    } else if (type >= IAMF_OBU_AUDIO_FRAME && type <= IAMF_OBU_AUDIO_FRAME_ID17) {
      // All substreams share the temporal-unit count; counting one substream's
      // frames (the first-seen frame OBU type) counts temporal units.
      if (countedFrameType === null) countedFrameType = type
      if (type === countedFrameType) {
        temporalUnits++
        trimmedSamples += trimStart + trimEnd
      }
    }

    offset = next
  }

  if (!codecId || samplesPerFrame <= 0 || temporalUnits === 0) return null

  const totalSamples = Math.max(0, temporalUnits * samplesPerFrame - trimmedSamples)
  return {
    codecId,
    samplesPerFrame,
    sampleRate,
    temporalUnits,
    totalSamples,
    durationSeconds: sampleRate ? totalSamples / sampleRate : null,
  }
}

function parseDecoderConfigSampleRate(
  codecId: string,
  bytes: Uint8Array,
  start: number,
  end: number
): number | null {
  if (codecId === 'Opus') return 48000 // libiamf always decodes Opus at 48 kHz output
  if (codecId === 'ipcm') {
    // sample_format_flags(u8), sample_size(u8), sample_rate(u32 BE)
    if (start + 6 > end) return null
    return (bytes[start + 2] << 24) | (bytes[start + 3] << 16) | (bytes[start + 4] << 8) | bytes[start + 5]
  }
  if (codecId === 'fLaC') {
    // METADATA_BLOCK header (4 bytes) + STREAMINFO; sample rate is the 20 bits
    // at STREAMINFO offset 10.
    const s = start + 4
    if (s + 13 > end) return null
    return (bytes[s + 10] << 12) | (bytes[s + 11] << 4) | (bytes[s + 12] >> 4)
  }
  return null
}
