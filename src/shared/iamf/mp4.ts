// Minimal ISO-BMFF (MP4) walking for IAMF-in-MP4 (Eclipsa Audio). Real-world
// Eclipsa content (YouTube) ships as IAMF-Opus in MP4: the audio track's
// sample entry fourcc is 'iamf', its 'iacb' box carries the descriptor OBUs,
// and each sample is a temporal unit's worth of OBUs. This module detects the
// track (Stage A: routing/scan) and extracts a plain OBU stream the wasm
// decoder consumes unchanged (Stage B).

interface Box {
  type: string
  /** Payload start (after size+type and any largesize). */
  start: number
  /** Payload end (exclusive). */
  end: number
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

function readU64(bytes: Uint8Array, offset: number): number {
  // Sizes beyond 2^53 are not representable; audio files never get there.
  return readU32(bytes, offset) * 4294967296 + readU32(bytes, offset + 4)
}

function boxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

/** Iterates the boxes in [start, end); tolerates truncated tails. */
function* boxes(bytes: Uint8Array, start: number, end: number): Generator<Box> {
  let offset = start
  while (offset + 8 <= end) {
    let size = readU32(bytes, offset)
    const type = boxType(bytes, offset + 4)
    let payloadStart = offset + 8
    if (size === 1) {
      if (offset + 16 > end) return
      size = readU64(bytes, offset + 8)
      payloadStart = offset + 16
    } else if (size === 0) {
      size = end - offset // box extends to the end of the enclosing scope
    }
    if (size < payloadStart - offset) return
    const boxEnd = offset + size
    if (boxEnd > end) return
    yield { type, start: payloadStart, end: boxEnd }
    offset = boxEnd
  }
}

function findBox(bytes: Uint8Array, start: number, end: number, type: string): Box | null {
  for (const box of boxes(bytes, start, end)) {
    if (box.type === type) return box
  }
  return null
}

function findBoxPath(bytes: Uint8Array, start: number, end: number, path: string[]): Box | null {
  let scope: Box | null = null
  let s = start
  let e = end
  for (const type of path) {
    scope = findBox(bytes, s, e, type)
    if (!scope) return null
    s = scope.start
    e = scope.end
  }
  return scope
}

interface IamfTrack {
  trackId: number
  /** Descriptor OBUs from the sample entry's iacb box. */
  descriptorObus: Uint8Array
  stbl: Box
  trak: Box
}

function findIamfTrack(bytes: Uint8Array): IamfTrack | null {
  const moov = findBox(bytes, 0, bytes.length, 'moov')
  if (!moov) return null
  for (const trak of boxes(bytes, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue
    const stbl = findBoxPath(bytes, trak.start, trak.end, ['mdia', 'minf', 'stbl'])
    if (!stbl) continue
    const stsd = findBox(bytes, stbl.start, stbl.end, 'stsd')
    if (!stsd) continue
    // stsd payload: version/flags (4) + entry_count (4), then sample entries.
    for (const entry of boxes(bytes, stsd.start + 8, stsd.end)) {
      if (entry.type !== 'iamf') continue
      const descriptorObus = readIacbConfigObus(bytes, entry)
      if (!descriptorObus) return null
      const tkhd = findBox(bytes, trak.start, trak.end, 'tkhd')
      const trackId = tkhd ? readTrackId(bytes, tkhd) : 0
      return { trackId, descriptorObus, stbl, trak }
    }
  }
  return null
}

function readTrackId(bytes: Uint8Array, tkhd: Box): number {
  const version = bytes[tkhd.start]
  // v0: ctime(4) mtime(4) track_ID(4); v1: 8+8+4 — after version/flags (4).
  const offset = tkhd.start + 4 + (version === 1 ? 16 : 8)
  return offset + 4 <= tkhd.end ? readU32(bytes, offset) : 0
}

function readIacbConfigObus(bytes: Uint8Array, entry: Box): Uint8Array | null {
  // AudioSampleEntry fixed fields are 28 bytes; child boxes follow. Fall back
  // to scanning the entry payload if a writer deviated.
  let iacb = findBox(bytes, entry.start + 28, entry.end, 'iacb')
  if (!iacb) {
    for (let probe = entry.start; probe + 8 <= entry.end && !iacb; probe++) {
      if (boxType(bytes, probe + 4) === 'iacb') {
        const size = readU32(bytes, probe)
        if (size >= 8 && probe + size <= entry.end) {
          iacb = { type: 'iacb', start: probe + 8, end: probe + size }
        }
      }
    }
  }
  if (!iacb) return null
  // iacb payload: configurationVersion (u8), configOBUs_size (leb128),
  // configOBUs.
  let p = iacb.start + 1
  let size = 0
  for (let i = 0; i < 8; i++) {
    if (p >= iacb.end) return null
    const byte = bytes[p]
    p++
    size += (byte & 0x7f) * 2 ** (7 * i)
    if ((byte & 0x80) === 0) break
  }
  if (p + size > iacb.end) return null
  return bytes.subarray(p, p + size)
}

/**
 * True when any track's stsd contains an 'iamf' sample entry. Walks moov only
 * (never touches mdat), so it is cheap even on large files.
 */
export function mp4HasIamfTrack(bytes: Uint8Array): boolean {
  return findIamfTrack(bytes) !== null
}

interface SampleRange {
  offset: number
  size: number
}

/** Samples from the classic (non-fragmented) stbl tables. */
function collectStblSamples(bytes: Uint8Array, stbl: Box): SampleRange[] {
  const stsz = findBox(bytes, stbl.start, stbl.end, 'stsz')
  const stsc = findBox(bytes, stbl.start, stbl.end, 'stsc')
  const stco = findBox(bytes, stbl.start, stbl.end, 'stco')
  const co64 = findBox(bytes, stbl.start, stbl.end, 'co64')
  if (!stsz || !stsc || (!stco && !co64)) return []

  const uniformSize = readU32(bytes, stsz.start + 4)
  const sampleCount = readU32(bytes, stsz.start + 8)
  const sampleSize = (index: number): number =>
    uniformSize !== 0 ? uniformSize : readU32(bytes, stsz.start + 12 + index * 4)

  const chunkOffsets: number[] = []
  if (stco) {
    const count = readU32(bytes, stco.start + 4)
    for (let i = 0; i < count; i++) chunkOffsets.push(readU32(bytes, stco.start + 8 + i * 4))
  } else if (co64) {
    const count = readU32(bytes, co64.start + 4)
    for (let i = 0; i < count; i++) chunkOffsets.push(readU64(bytes, co64.start + 8 + i * 8))
  }

  const stscCount = readU32(bytes, stsc.start + 4)
  const runs: Array<{ firstChunk: number; samplesPerChunk: number }> = []
  for (let i = 0; i < stscCount; i++) {
    const base = stsc.start + 8 + i * 12
    runs.push({ firstChunk: readU32(bytes, base), samplesPerChunk: readU32(bytes, base + 4) })
  }

  const samples: SampleRange[] = []
  let sampleIndex = 0
  for (let chunk = 0; chunk < chunkOffsets.length && sampleIndex < sampleCount; chunk++) {
    let samplesInChunk = 1
    for (const run of runs) {
      if (chunk + 1 >= run.firstChunk) samplesInChunk = run.samplesPerChunk
    }
    let offset = chunkOffsets[chunk]
    for (let s = 0; s < samplesInChunk && sampleIndex < sampleCount; s++) {
      const size = sampleSize(sampleIndex)
      samples.push({ offset, size })
      offset += size
      sampleIndex++
    }
  }
  return samples
}

/** Samples from movie fragments (moof/traf/trun), fMP4 as YouTube delivers. */
function collectFragmentSamples(bytes: Uint8Array, trackId: number): SampleRange[] {
  // trex default sample size (moov/mvex), keyed by track.
  let trexDefaultSize = 0
  const moov = findBox(bytes, 0, bytes.length, 'moov')
  if (moov) {
    const mvex = findBox(bytes, moov.start, moov.end, 'mvex')
    if (mvex) {
      for (const trex of boxes(bytes, mvex.start, mvex.end)) {
        if (trex.type !== 'trex') continue
        if (readU32(bytes, trex.start + 4) === trackId) {
          trexDefaultSize = readU32(bytes, trex.start + 16)
        }
      }
    }
  }

  const samples: SampleRange[] = []
  for (const moof of boxes(bytes, 0, bytes.length)) {
    if (moof.type !== 'moof') continue
    const moofStart = moof.start - 8 // box header position: base for default-base-is-moof
    for (const traf of boxes(bytes, moof.start, moof.end)) {
      if (traf.type !== 'traf') continue
      const tfhd = findBox(bytes, traf.start, traf.end, 'tfhd')
      if (!tfhd) continue
      const tfhdFlags = readU32(bytes, tfhd.start) & 0xffffff
      let p = tfhd.start + 4
      const tfhdTrackId = readU32(bytes, p)
      p += 4
      if (tfhdTrackId !== trackId) continue
      let baseDataOffset = moofStart
      if (tfhdFlags & 0x01) {
        baseDataOffset = readU64(bytes, p)
        p += 8
      }
      if (tfhdFlags & 0x02) p += 4 // sample_description_index
      if (tfhdFlags & 0x08) p += 4 // default_sample_duration
      let defaultSize = trexDefaultSize
      if (tfhdFlags & 0x10) {
        defaultSize = readU32(bytes, p)
        p += 4
      }

      let runOffset = 0
      let runOffsetValid = false
      for (const trun of boxes(bytes, traf.start, traf.end)) {
        if (trun.type !== 'trun') continue
        const trunFlags = readU32(bytes, trun.start) & 0xffffff
        const count = readU32(bytes, trun.start + 4)
        let q = trun.start + 8
        if (trunFlags & 0x01) {
          runOffset = readU32(bytes, q) | 0 // signed, but audio files stay positive
          runOffsetValid = true
          q += 4
        } else if (!runOffsetValid) {
          runOffset = 0
          runOffsetValid = true
        }
        if (trunFlags & 0x04) q += 4 // first_sample_flags
        let offset = baseDataOffset + runOffset
        for (let s = 0; s < count; s++) {
          if (trunFlags & 0x100) q += 4 // sample_duration
          let size = defaultSize
          if (trunFlags & 0x200) {
            size = readU32(bytes, q)
            q += 4
          }
          if (trunFlags & 0x400) q += 4 // sample_flags
          if (trunFlags & 0x800) q += 4 // sample_composition_time_offset
          samples.push({ offset, size })
          offset += size
        }
        runOffset = offset - baseDataOffset // subsequent truns continue after
      }
    }
  }
  return samples
}

/**
 * Movie duration in seconds from moov/mvhd. Works on a full file or on a
 * buffer that starts at the moov box (the scan path reads only moov from
 * disk). Null when absent/malformed.
 */
export function readMp4DurationSeconds(bytes: Uint8Array): number | null {
  const moov = findBox(bytes, 0, bytes.length, 'moov')
  if (!moov) return null
  const mvhd = findBox(bytes, moov.start, moov.end, 'mvhd')
  if (!mvhd) return null
  const version = bytes[mvhd.start]
  let timescale: number
  let duration: number
  if (version === 1) {
    if (mvhd.start + 4 + 16 + 12 > mvhd.end) return null
    timescale = readU32(bytes, mvhd.start + 4 + 16)
    duration = readU64(bytes, mvhd.start + 4 + 20)
  } else {
    if (mvhd.start + 4 + 8 + 8 > mvhd.end) return null
    timescale = readU32(bytes, mvhd.start + 4 + 8)
    duration = readU32(bytes, mvhd.start + 4 + 12)
  }
  if (!timescale || !Number.isFinite(duration)) return null
  return duration / timescale
}

/**
 * Rebuilds a standalone IAMF OBU stream from an IAMF-in-MP4 file: descriptor
 * OBUs from the iacb box followed by every sample (each sample is one
 * temporal unit's OBUs). The result feeds the wasm decoder unchanged.
 */
export function extractIamfObuStreamFromMp4(bytes: Uint8Array): Uint8Array {
  const track = findIamfTrack(bytes)
  if (!track) throw new Error('MP4 file has no IAMF track')

  let samples = collectStblSamples(bytes, track.stbl)
  if (samples.length === 0) {
    samples = collectFragmentSamples(bytes, track.trackId)
  }
  if (samples.length === 0) throw new Error('IAMF track has no samples')

  let total = track.descriptorObus.length
  for (const sample of samples) total += sample.size
  const stream = new Uint8Array(total)
  stream.set(track.descriptorObus, 0)
  let write = track.descriptorObus.length
  for (const sample of samples) {
    if (sample.offset + sample.size > bytes.length) {
      throw new Error('IAMF sample range exceeds file size (truncated MP4?)')
    }
    stream.set(bytes.subarray(sample.offset, sample.offset + sample.size), write)
    write += sample.size
  }
  return stream
}
