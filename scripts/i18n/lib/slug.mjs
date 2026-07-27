/**
 * Key slugging, shared by both extractors and the context builder.
 *
 * These three must agree exactly. The extractors mint keys from this, and the context builder
 * reads the file name back out of a key (`auto.<file>.<text>`) to trace a message home — if
 * they drifted, context would silently attach to the wrong component.
 */

const MAX_SLUG_LENGTH = 56

/**
 * Truncates on a word boundary rather than mid-word.
 *
 * `auto.settingsview.navigate_astra_with_an_xbox_or_playstation_controller_d_` was the old
 * shape: cut mid-word, trailing underscore, and no clue what "d_" was. Keys are the first
 * thing a translator reads, so the last word either fits or is dropped.
 */
export function slug(value, maxLength = MAX_SLUG_LENGTH) {
  const normalized = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  if (normalized.length <= maxLength) return normalized || 'text'

  const truncated = normalized.slice(0, maxLength)
  const lastBoundary = truncated.lastIndexOf('_')
  // Keep the hard cut when the first word alone is longer than the budget; a single very long
  // token has no boundary to fall back to.
  const wordSafe = lastBoundary > 0 ? truncated.slice(0, lastBoundary) : truncated
  return wordSafe.replace(/_+$/, '') || 'text'
}

/** The slug an extractor would derive for a source file, used to map a key back to its file. */
export function fileSlug(fileName) {
  return slug(fileName.replace(/\.tsx?$/, ''))
}
