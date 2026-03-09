import type { IOptions } from 'music-metadata'
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
