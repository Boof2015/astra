import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { buildTransMessage, isBrokenSentence } from './lib/fragments.mjs'
import { slug } from './lib/slug.mjs'

/**
 * Rejoins sentences that the static extractor split across several catalog keys.
 *
 * `<p>Astra appends <code>/api/get</code> and <code>/api/search</code>. HTTP is …</p>` became five
 * messages. Translated separately and concatenated in English order they cannot form a correct
 * sentence in a language that orders clauses differently, so this converts each broken run into a
 * single `<Trans>` with the markup inlined as numbered tags — one key the translator can reorder
 * freely.
 *
 *   node scripts/i18n/fix-fragments.mjs --check   list what would change
 *   node scripts/i18n/fix-fragments.mjs --apply   rewrite the JSX and the catalogs
 */

const projectRoot = resolve(import.meta.dirname, '../..')
const rendererRoot = resolve(projectRoot, 'src/renderer')
const localesRoot = resolve(projectRoot, 'src/shared/i18n/locales/en')
const namespaces = ['common', 'settings', 'library', 'playback', 'integrations', 'errors']
const apply = process.argv.includes('--apply')
const verbose = process.argv.includes('--verbose')

const INLINE_WRAPPER_TAGS = new Set(['code', 'strong', 'em', 'b', 'i', 'kbd', 'small', 'mark', 'u'])

async function collectFiles(directory, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) await collectFiles(path, result)
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) result.push(path)
  }
  return result
}

function flatten(value, prefix, result) {
  if (typeof value === 'string') {
    result.set(prefix, value)
    return result
  }
  if (!value || typeof value !== 'object') return result
  for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, result)
  return result
}

function setNested(target, path, value) {
  let cursor = target
  for (const segment of path.slice(0, -1)) {
    cursor[segment] ??= {}
    cursor = cursor[segment]
  }
  cursor[path.at(-1)] = value
}

function deleteNested(target, path) {
  const parents = []
  let cursor = target
  for (const segment of path.slice(0, -1)) {
    if (cursor?.[segment] === undefined) return
    parents.push([cursor, segment])
    cursor = cursor[segment]
  }
  delete cursor[path.at(-1)]
  for (const [parent, segment] of parents.reverse()) {
    if (Object.keys(parent[segment]).length === 0) delete parent[segment]
  }
}

const catalogs = {}
const flatCatalogs = new Map()
for (const namespace of namespaces) {
  catalogs[namespace] = JSON.parse(await readFile(resolve(localesRoot, `${namespace}.json`), 'utf8'))
  flatCatalogs.set(namespace, flatten(catalogs[namespace], '', new Map()))
}
const textOf = (part) => flatCatalogs.get(part.namespace)?.get(part.key)

function readStringAttribute(openingElement, name) {
  for (const property of openingElement.attributes.properties) {
    if (!ts.isJsxAttribute(property) || property.name.getText() !== name) continue
    if (property.initializer && ts.isStringLiteral(property.initializer)) return property.initializer.text
  }
  return null
}

/** Ordered parts of one element's children, with source positions so the run can be replaced. */
function readRun(container, sourceFile) {
  const parts = []
  const walk = (child, wrap) => {
    if (ts.isJsxText(child)) {
      const value = child.text.replace(/\s+/g, ' ')
      if (value) parts.push({ literal: value, start: child.getStart(sourceFile), end: child.getEnd() })
      return
    }
    if (ts.isJsxSelfClosingElement(child) && child.tagName.getText(sourceFile) === 'LocalizedText') {
      const namespace = readStringAttribute(child, 'ns')
      const key = readStringAttribute(child, 'i18nKey')
      if (namespace && key) {
        parts.push({ namespace, key, wrap, start: child.getStart(sourceFile), end: child.getEnd() })
      } else {
        parts.push({ opaque: true, start: child.getStart(sourceFile), end: child.getEnd() })
      }
      return
    }
    if (ts.isJsxElement(child)) {
      const tag = child.openingElement.tagName.getText(sourceFile)
      if (INLINE_WRAPPER_TAGS.has(tag) && child.openingElement.attributes.properties.length === 0) {
        const before = parts.length
        for (const inner of child.children) walk(inner, tag)
        // A wrapper holding anything other than exactly one message is not a simple emphasis.
        if (parts.length - before !== 1) {
          parts.length = before
          parts.push({ opaque: true, start: child.getStart(sourceFile), end: child.getEnd() })
          return
        }
        // The part must span the wrapper, not the message inside it. Otherwise a run that begins
        // with a wrapped fragment starts replacing after `<kbd>`, leaving the opening tag behind
        // while its closing tag is swallowed by the replacement.
        parts.at(-1).start = child.getStart(sourceFile)
        parts.at(-1).end = child.getEnd()
        return
      }
      parts.push({ opaque: true, start: child.getStart(sourceFile), end: child.getEnd() })
      return
    }
    if (ts.isJsxExpression(child)) {
      parts.push({ opaque: true, start: child.getStart(sourceFile), end: child.getEnd() })
      return
    }
    parts.push({ opaque: true, start: child.getStart(sourceFile), end: child.getEnd() })
  }
  for (const child of container.children) walk(child, null)
  return parts
}

const seenKeys = new Set()
for (const namespace of namespaces) {
  for (const key of flatCatalogs.get(namespace).keys()) seenKeys.add(`${namespace}:${key}`)
}

const usedKeys = new Map()
const conversions = []
const skipped = []

for (const filePath of (await collectFiles(rendererRoot)).sort()) {
  const sourceText = await readFile(filePath, 'utf8')
  if (!sourceText.includes('LocalizedText')) continue
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const relativePath = relative(projectRoot, filePath).split(sep).join('/')
  const fileKey = slug(basename(filePath).replace(/\.tsx$/, ''))
  const fileConversions = []

  const visit = (node) => {
    if (ts.isJsxElement(node)) {
      const parts = readRun(node, sourceFile)
      if (isBrokenSentence(parts, textOf)) {
        const messageIndexes = parts.map((part, index) => (part.key !== undefined ? index : -1)).filter((index) => index !== -1)
        const from = messageIndexes[0]
        const to = messageIndexes.at(-1)
        const span = parts.slice(from, to + 1)

        // An opaque node inside the sentence (a conditional, a nested component) cannot be
        // expressed as a numbered Trans tag without guessing at its runtime output.
        if (span.some((part) => part.opaque)) {
          skipped.push({ file: relativePath, reason: 'contains a dynamic or nested node', preview: span.map((p) => textOf(p) ?? p.literal ?? '{…}').join('').trim().slice(0, 90) })
        } else {
          fileConversions.push({ span, from, to, parts })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  if (fileConversions.length === 0) continue

  const namespaceOf = fileConversions[0].span.find((part) => part.namespace)?.namespace
  const replacements = []

  for (const conversion of fileConversions) {
    const { span } = conversion
    const namespace = span.find((part) => part.namespace)?.namespace ?? namespaceOf
    const message = buildTransMessage(span, textOf)
    if (!message) continue

    let key = `auto.${fileKey}.${slug(message)}`
    if (seenKeys.has(`${namespace}:${key}`)) {
      key = `${key}_${createHash('sha1').update(message).digest('hex').slice(0, 7)}`
    }
    seenKeys.add(`${namespace}:${key}`)

    // Rebuild the children as literal markup so <Trans> can index them the same way the catalog
    // string numbers them.
    const children = span.map((part) => {
      if (part.literal !== undefined) return part.literal
      const text = textOf(part) ?? ''
      return part.wrap ? `<${part.wrap}>${text}</${part.wrap}>` : text
    }).join('')

    replacements.push({
      start: span[0].start,
      end: span.at(-1).end,
      text: `<Trans ns="${namespace}" i18nKey="${key}">${children}</Trans>`,
    })

    conversions.push({ file: relativePath, namespace, key, message, replaced: span.filter((p) => p.key).map((p) => `${p.namespace}:${p.key}`) })
    for (const part of span) {
      if (part.key) usedKeys.set(`${part.namespace}:${part.key}`, (usedKeys.get(`${part.namespace}:${part.key}`) ?? 0))
    }
  }

  if (replacements.length === 0 || !apply) continue

  replacements.sort((left, right) => right.start - left.start)
  let updated = sourceText
  for (const replacement of replacements) {
    updated = `${updated.slice(0, replacement.start)}${replacement.text}${updated.slice(replacement.end)}`
  }
  if (!/from 'react-i18next'/.test(updated)) {
    updated = `import { Trans } from 'react-i18next'\n${updated}`
  } else if (!/\bTrans\b[^}]*}\s*from 'react-i18next'/.test(updated)) {
    updated = updated.replace(/import\s*{([^}]*)}\s*from 'react-i18next'/, (match, names) => `import {${names.trimEnd()}, Trans } from 'react-i18next'`)
  }
  await writeFile(filePath, updated, 'utf8')
}

if (apply) {
  for (const conversion of conversions) {
    setNested(catalogs[conversion.namespace], conversion.key.split('.'), conversion.message)
  }
  // Drop the fragments that no longer have a call site. Re-scanning the written tree is the only
  // honest way to know: a fragment reused elsewhere must survive.
  const remaining = (await Promise.all(
    (await collectFiles(rendererRoot)).map((path) => readFile(path, 'utf8'))
  )).join('\n')
  let removed = 0
  for (const conversion of conversions) {
    for (const fragment of conversion.replaced) {
      const [namespace, key] = [fragment.slice(0, fragment.indexOf(':')), fragment.slice(fragment.indexOf(':') + 1)]
      if (remaining.includes(`"${key}"`) || remaining.includes(`'${namespace}:${key}'`)) continue
      deleteNested(catalogs[namespace], key.split('.'))
      removed += 1
    }
  }
  for (const namespace of namespaces) {
    await writeFile(resolve(localesRoot, `${namespace}.json`), `${JSON.stringify(catalogs[namespace], null, 2)}\n`, 'utf8')
  }
  console.log(`Removed ${removed} orphaned fragment key(s).`)
}

if (verbose) {
  for (const conversion of conversions) {
    console.log(`\n  ${conversion.file}`)
    console.log(`    ${conversion.replaced.length} keys -> ${conversion.namespace}:${conversion.key}`)
    console.log(`    "${conversion.message.slice(0, 140)}"`)
  }
  for (const entry of skipped) {
    console.log(`\n  SKIP ${entry.file}: ${entry.reason}\n    "${entry.preview}"`)
  }
}

console.log(
  `${apply ? 'Converted' : 'Would convert'} ${conversions.length} broken sentence(s) `
    + `covering ${conversions.reduce((sum, c) => sum + c.replaced.length, 0)} fragment key(s); `
    + `${skipped.length} skipped as too dynamic to rejoin safely.`
)
