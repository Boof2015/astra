import type { IOptions, IAudioMetadata } from 'music-metadata'
import type { FfprobeAudioMetadata } from '../../shared/audio/ffprobeMetadata'
import { extname } from 'path'

const FULL_OGG_METADATA_EXTENSIONS = new Set([
  '.ogg',
  '.opus'
])

export function getMusicMetadataParseOptions(filePath: string, overrides?: IOptions): IOptions | undefined {
  const extension = extname(filePath).toLowerCase()
  const requiresFullParse = FULL_OGG_METADATA_EXTENSIONS.has(extension)

  if (!requiresFullParse && !overrides) {
    return undefined
  }

  return {
    ...overrides,
    // music-metadata stops Ogg parsing early unless duration parsing is enabled,
    // which can truncate large METADATA_BLOCK_PICTURE payloads in Opus/Vorbis tags.
    duration: requiresFullParse || overrides?.duration === true
  }
}

// Some playable MP4 sample descriptions are rejected by music-metadata before tags are read.
export function musicMetadataFromFfprobe(probe: FfprobeAudioMetadata): IAudioMetadata {
  const tags = probe.tags
  const number = (value: string | undefined): number | null => {
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  }
  const position = (value: string | undefined) => {
    const [no, of] = (value ?? '').split('/')
    return { no: number(no), of: number(of) }
  }
  return {
    format: {
      trackInfo: [], tagTypes: [],
      codec: probe.codec ?? undefined, codecProfile: probe.codecProfile ?? undefined,
      numberOfChannels: probe.channels ?? undefined, duration: probe.duration ?? undefined,
      sampleRate: probe.sampleRate ?? undefined, bitsPerSample: probe.bitDepth ?? undefined,
      bitrate: probe.bitrate ?? undefined
    },
    common: {
      title: tags.title, artist: tags.artist, album: tags.album,
      albumartist: tags.album_artist ?? tags.albumartist,
      genre: tags.genre ? [tags.genre] : undefined,
      date: tags.date, year: number((tags.date ?? tags.year)?.slice(0, 4)) ?? undefined,
      track: position(tags.track), disk: position(tags.disc), movementIndex: position(undefined),
      bpm: number(tags.bpm ?? tags.tbpm) ?? undefined,
      key: tags.initialkey ?? tags.key
    },
    // Preserve tags for ReplayGain and other consumers of native metadata.
    native: { ffprobe: Object.entries(tags).map(([id, value]) => ({ id, value })) },
    quality: { warnings: [{ message: 'Metadata recovered with ffprobe after the primary parser failed.' }] }
  }
}
