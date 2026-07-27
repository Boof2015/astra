import { readFile, readdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import ts from 'typescript'
import { compareSourceLookupCandidates } from './lib/lookup.mjs'

/**
 * Guards translateSourceText() against ambiguous reverse lookups.
 *
 * `translateSourceText` (src/renderer/i18n.ts) maps an English string back to a catalog key so
 * that shared data models — settings sections, keyboard shortcut tables — can stay plain
 * English while still rendering translated. The lookup keeps the FIRST key it sees for any given
 * string, so when two keys share the same English one of them wins arbitrarily.
 *
 * While the app is English-only this is undetectable: every candidate key resolves to the same
 * word. The moment a second locale exists, a string that resolved to the wrong key renders the
 * wrong translation, and nothing about it looks broken. Catching it here means fixing it by
 * giving one call site an explicit key rather than discovering it in a bug report.
 *
 * Only strings that the bridge can actually be asked to resolve are checked. Duplicate English
 * elsewhere in the catalogs is fine and common ("Close" legitimately appears 18 times) — it only
 * matters when a constants module hands that exact text to the bridge.
 */

const projectRoot = resolve(import.meta.dirname, '../..')
const rendererRoot = resolve(projectRoot, 'src/renderer')
const localesRoot = resolve(projectRoot, 'src/shared/i18n/locales/en')
const namespaces = ['common', 'settings', 'library', 'playback', 'integrations', 'errors']

// Mirrors extract-runtime-copy.mjs: the display properties on plain object literals that end up
// rendered through the bridge.
const propertyNames = new Set(['label', 'description', 'message', 'title', 'placeholder', 'ariaLabel', 'action'])

async function collectFiles(directory, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) await collectFiles(path, result)
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) result.push(path)
  }
  return result
}

function flatten(value, prefix, result) {
  if (typeof value === 'string') {
    result.push([prefix, value])
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, result)
}

const keysByText = new Map()
for (const namespace of namespaces) {
  const entries = []
  flatten(JSON.parse(await readFile(resolve(localesRoot, `${namespace}.json`), 'utf8')), '', entries)
  for (const [key, text] of entries) {
    if (!keysByText.has(text)) keysByText.set(text, [])
    keysByText.get(text).push(`${namespace}:${key}`)
  }
}

const bridgedTexts = new Map()
for (const filePath of (await collectFiles(rendererRoot)).sort()) {
  const sourceText = await readFile(filePath, 'utf8')
  if (!propertyNames.values().some((name) => sourceText.includes(`${name}:`))) continue
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const relativePath = filePath.slice(projectRoot.length + 1).split(sep).join('/')

  const visit = (node) => {
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(sourceFile).replace(/^['"]|['"]$/g, '')
      if (
        propertyNames.has(name)
        && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))
      ) {
        const value = node.initializer.text.trim().replace(/\s+/g, ' ')
        if (value && !bridgedTexts.has(value)) {
          bridgedTexts.set(value, `${relativePath}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

/**
 * Astra shipped 39 of these before the check existed. Failing on all of them would mean holding
 * translator context hostage to an unrelated refactor, so the known set is recorded and only new
 * ambiguity fails. Entries that stop being ambiguous are reported too, which keeps the file
 * shrinking rather than quietly outliving the problem.
 */
const baselinePath = resolve(import.meta.dirname, 'source-lookup-baseline.json')
const baseline = new Set(JSON.parse(await readFile(baselinePath, 'utf8')).knownAmbiguous ?? [])

const ambiguous = []
for (const [text, site] of bridgedTexts) {
  const keys = keysByText.get(text)
  if (!keys || keys.length < 2) continue
  ambiguous.push({ text, site, keys: [...keys].sort(compareSourceLookupCandidates) })
}

let failed = false
for (const { text, site, keys } of ambiguous) {
  if (baseline.has(text)) continue
  failed = true
  console.error(
    `${site}: ${JSON.stringify(text.slice(0, 60))} resolves to ${keys.length} keys `
      + `(${keys.join(', ')}); translateSourceText will pick ${keys[0]}. `
      + 'Give this call site an explicit key, or add the text to source-lookup-baseline.json.'
  )
}

const stillAmbiguous = new Set(ambiguous.map((entry) => entry.text))
const resolved = [...baseline].filter((text) => !stillAmbiguous.has(text))
for (const text of resolved) {
  console.warn(`${JSON.stringify(text)} is no longer ambiguous; remove it from source-lookup-baseline.json.`)
}

console.log(
  `Checked ${bridgedTexts.size} bridged string(s) against ${keysByText.size} distinct message(s): `
    + `${ambiguous.length} ambiguous (${baseline.size} baselined, ${resolved.length} now resolvable).`
)
if (failed) process.exitCode = 1
