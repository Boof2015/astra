/**
 * Identifies sentences the extractor broke into several catalog keys.
 *
 * `extract-static-ui.mjs` splits JSX text at every element boundary, so
 * `<p>Astra appends <code>/api/get</code> and …</p>` became five independent messages. Each
 * fragment is then translated in isolation and concatenated back in English word order, which
 * cannot produce a correct sentence in a language that orders clauses differently. No amount of
 * context metadata fixes it; the sentence has to become one key again.
 *
 * A run of sibling labels ("Tracks Albums Artists" in a nav bar) looks similar to the AST but is
 * genuinely several independent strings, so the two must be told apart.
 */

/**
 * A run needs `<Trans>` when its parts are woven together rather than merely adjacent: an inline
 * wrapper, literal punctuation, or an interpolated value sitting *between* two messages all mean
 * the surrounding text is one sentence. Whitespace-only separation is what a list of labels looks
 * like, and those are left alone.
 */
export function isBrokenSentence(parts, textOf = () => null) {
  const messageIndexes = parts
    .map((part, index) => (part.key !== undefined ? index : -1))
    .filter((index) => index !== -1)
  if (messageIndexes.length < 2) return false

  const first = messageIndexes[0]
  const last = messageIndexes.at(-1)

  // Only what sits strictly *between* the first and last message counts. A wrapper on the
  // endpoints is decoration around the run — `<strong>Tracks</strong> <strong>Albums</strong>`
  // is a row of labels that each happen to be bold, not one sentence.
  for (let index = first + 1; index < last; index += 1) {
    const part = parts[index]
    if (part.key !== undefined) {
      // A fragment wrapped in <code>/<strong> mid-run is emphasis inside a sentence.
      if (part.wrap) return true
      continue
    }
    if (part.dynamic !== undefined) return true
    if (part.literal !== undefined && part.literal.trim()) return true
  }

  // A fragment that starts lowercase cannot be a standalone label; it is the continuation of the
  // fragment before it. This catches sentences split at a boundary with nothing woven between.
  for (const index of messageIndexes.slice(1)) {
    const text = textOf(parts[index])
    if (typeof text === 'string' && /^\p{Ll}/u.test(text)) return true
  }

  return false
}

/**
 * react-i18next numbers a `<Trans>` element's children by position, so the catalog string refers
 * to markup as `<1>…</1>`. Building that here keeps the numbering in one place: getting it wrong
 * silently drops the markup at runtime rather than failing.
 */
export function buildTransMessage(parts, textOf) {
  let message = ''
  let childIndex = 0
  let pendingText = false

  // The index must match how React parses the emitted JSX, not how many parts there are.
  // Adjacent literals and unwrapped fragments merge into ONE text child, so counting parts
  // numbers the tags too high and the markup silently vanishes at runtime.
  for (const part of parts) {
    if (part.literal !== undefined) {
      message += part.literal
      if (part.literal) pendingText = true
      continue
    }
    if (part.dynamic !== undefined) {
      message += `{{${part.dynamic || 'value'}}}`
      pendingText = true
      continue
    }
    const text = textOf(part) ?? ''
    if (!part.wrap) {
      message += text
      if (text) pendingText = true
      continue
    }
    if (pendingText) {
      childIndex += 1
      pendingText = false
    }
    message += `<${childIndex}>${text}</${childIndex}>`
    childIndex += 1
  }

  // The extractor trimmed each fragment, so rejoining leaves doubled spaces where markup sat.
  return message.replace(/[ \t]+/g, ' ').replace(/ ([.,;:!?])/g, '$1').trim()
}
