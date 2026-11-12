export interface FfprobeAudioMetadata {
  channels: number | null
  codec: string | null
  codecProfile: string | null
  isAtmosJoc: boolean
  hints: string[]
  duration: number | null
  sampleRate: number | null
  bitDepth: number | null
  bitrate: number | null
  tags: Record<string, string>
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveNumber(value: unknown): number | null {
  const number = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN
  return Number.isFinite(number) && number > 0 ? number : null
}

export function isAtmosJocStream(codec?: string | null, profile?: string | null, hints: string[] = []): boolean {
  const combined = `${codec ?? ''} ${profile ?? ''} ${hints.join(' ')}`.toLowerCase()
  const mentionsAtmos = combined.includes('joc') || combined.includes('atmos') || combined.includes('dby1')
  const isEc3Family = ['ec-3', 'eac3', 'ec3', 'e-ac-3', 'dolby digital plus', 'dd+']
    .some(value => combined.includes(value))
  return combined.includes('joc') || (mentionsAtmos && isEc3Family)
}

// Shared by direct opening, library import, and the upgrade refresh.
export function parseFfprobeAudioMetadata(stdout: string): FfprobeAudioMetadata | null {
  let parsed: unknown
  try { parsed = JSON.parse(stdout) } catch { return null }
  if (!record(parsed) || !Array.isArray(parsed.streams)) return null
  const streams = parsed.streams.filter(record)
  const stream = streams.find(entry => entry.codec_type === 'audio')
    ?? streams.find(entry => entry.codec_type === undefined)
  if (!stream) return null
  const codec = text(stream.codec_name) ?? text(stream.codec_long_name)
  if (!codec) return null
  const codecProfile = text(stream.profile)
  const format = record(parsed.format) ? parsed.format : {}
  const tags: Record<string, string> = {}
  for (const source of [stream.tags, format.tags]) {
    if (record(source)) for (const [key, value] of Object.entries(source)) {
      const tag = text(value)
      if (tag) tags[key.toLowerCase()] = tag
    }
  }
  const channels = Number(stream.channels)
  const hints: string[] = []
  const push = (value: unknown) => { const hint = text(value); if (hint) hints.push(hint) }
  for (const key of ['codec_name', 'codec_long_name', 'profile', 'codec_tag_string', 'codec_tag', 'channel_layout']) {
    push(stream[key])
  }
  if (record(stream.tags)) Object.values(stream.tags).forEach(push)
  if (Array.isArray(stream.side_data_list)) {
    stream.side_data_list.filter(record).forEach(entry => Object.values(entry).forEach(push))
  }
  if (record(parsed.format)) {
    push(parsed.format.format_name)
    push(parsed.format.format_long_name)
    if (record(parsed.format.tags)) Object.values(parsed.format.tags).forEach(push)
  }
  return {
    channels: Number.isInteger(channels) && channels > 0 ? channels : null,
    codec, codecProfile, hints, tags,
    duration: positiveNumber(stream.duration) ?? positiveNumber(format.duration),
    sampleRate: positiveNumber(stream.sample_rate),
    bitDepth: positiveNumber(stream.bits_per_raw_sample) ?? positiveNumber(stream.bits_per_sample),
    bitrate: positiveNumber(stream.bit_rate) ?? positiveNumber(format.bit_rate),
    isAtmosJoc: isAtmosJocStream(codec, codecProfile, hints)
  }
}
