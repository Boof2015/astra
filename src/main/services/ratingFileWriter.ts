import { chmod, copyFile, mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { parseFile, updateFile, type TagPatch } from 'music-metadata'
import { buildRatingTagPatch, extractRatingTag } from '../utils/ratingTags'

const supportedExtensions = new Set(['.mp3', '.flac', '.ogg', '.opus', '.m4a'])
const writes = new Map<string, Promise<void>>()
const requestedWrites = new Map<string, Promise<void>>()

/** Called only by explicit local rating edits, never by the scanner. */
export async function writeRatingToFile(path: string, rating: number | null, stillAllowed: () => boolean): Promise<void> {
  // Establish order before the first async filesystem operation; realpath calls
  // themselves can finish out of order during rapid consecutive edits.
  const key = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  const previous = requestedWrites.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(() => writeResolvedRatingToFile(path, rating, stillAllowed))
  requestedWrites.set(key, operation)
  try { await operation } finally {
    if (requestedWrites.get(key) === operation) requestedWrites.delete(key)
  }
}

async function writeResolvedRatingToFile(path: string, rating: number | null, stillAllowed: () => boolean): Promise<void> {
  const resolved = await realpath(path)
  const previous = writes.get(resolved) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(async () => {
    if (!stillAllowed()) throw new Error('File writing was disabled or this rating edit was superseded.')
    const extension = extname(resolved).toLowerCase()
    if (!supportedExtensions.has(extension)) throw new Error('Writing ratings is not supported for this file format.')
    const original = await stat(resolved)
    if (!original.isFile() || !(original.mode & 0o222)) throw new Error('The music file is not writable.')
    const directory = await mkdtemp(join(dirname(resolved), '.astra-rating-'))
    const staged = join(directory, `track${extension}`)
    try {
      await copyFile(resolved, staged)
      const metadata = await parseFile(staged, { skipCovers: true })
      if (extension === '.mp3' && metadata.format.tagTypes?.some(type => type === 'ID3v2.2' || type === 'ID3v2.3')) {
        throw new Error('Writing ratings to ID3v2.2/2.3 tags is unsupported. The rating was saved in Astra; the file was left unchanged.')
      }
      const native = buildRatingTagPatch(metadata, extension, rating) as NonNullable<TagPatch['native']>
      // Only our disposable copy may be overwritten in place. Never opt into
      // replaceId3: it discards unspecified fields from older tags.
      await updateFile(staged, { native }, { atomic: false })
      const verified = await parseFile(staged, { skipCovers: true })
      if (extractRatingTag(verified) !== rating) throw new Error('Could not verify the written rating; the original file was left unchanged.')
      await chmod(staged, original.mode)
      const current = await stat(resolved)
      if (current.dev !== original.dev || current.ino !== original.ino || current.size !== original.size
        || current.mtimeMs !== original.mtimeMs || current.ctimeMs !== original.ctimeMs || await realpath(path) !== resolved) {
        throw new Error('The music file changed during the edit. Try rating it again.')
      }
      if (!stillAllowed()) throw new Error('File writing was disabled or this rating edit was superseded.')
      await rename(staged, resolved)
    } finally {
      // This unique sibling directory is owned by this operation, not a user path.
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  })
  writes.set(resolved, operation)
  try { await operation } finally {
    if (writes.get(resolved) === operation) writes.delete(resolved)
  }
}
