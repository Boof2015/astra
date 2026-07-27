import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readTranslationState, writeTranslationState } from './lib/state.mjs'

/**
 * Applies the key renames listed in src/shared/i18n/locales/renames.json to every translation.
 *
 * Renaming a key is a maintainer edit to the English catalog and the source that references it.
 * The tedious, forgettable part is the other N locale files: miss one and that translation is
 * orphaned, falls back to English forever, and the validator reports it only as an anonymous
 * "1 missing, 1 obsolete" pair with no hint the two are the same string.
 *
 * A rename does not change the English text, so translations stay valid and are NOT flagged for
 * review — their recorded source text moves across with them.
 *
 * The ledger is hand-written on purpose. Fuzzy-matching removed keys against added ones was the
 * obvious alternative and it is not worth it: a false positive silently pairs two unrelated
 * strings and ships a confidently wrong translation, which is far worse than the missing one it
 * was trying to save.
 *
 *   node scripts/i18n/migrate-keys.mjs --check   report what would move
 *   node scripts/i18n/migrate-keys.mjs --apply   move it
 */

const projectRoot = resolve(import.meta.dirname, '../..')
const localesRoot = resolve(projectRoot, 'src/shared/i18n/locales')
const namespaces = new Set(['common', 'settings', 'library', 'playback', 'integrations', 'errors'])
const apply = process.argv.includes('--apply')

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

function getNested(target, path) {
  return path.reduce((cursor, segment) => (cursor == null ? undefined : cursor[segment]), target)
}

function setNested(target, path, value) {
  let cursor = target
  for (const segment of path.slice(0, -1)) {
    cursor[segment] ??= {}
    cursor = cursor[segment]
  }
  cursor[path.at(-1)] = value
}

/** Removes a key and any ancestor objects it leaves empty, so no husks accumulate. */
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

function parseEntry(entry, index) {
  for (const field of ['from', 'to']) {
    if (typeof entry?.[field] !== 'string' || !entry[field].includes(':')) {
      throw new Error(`renames.json[${index}]: "${field}" must be a "namespace:key" string.`)
    }
  }
  const [fromNamespace, fromKey] = [entry.from.slice(0, entry.from.indexOf(':')), entry.from.slice(entry.from.indexOf(':') + 1)]
  const [toNamespace, toKey] = [entry.to.slice(0, entry.to.indexOf(':')), entry.to.slice(entry.to.indexOf(':') + 1)]
  for (const namespace of [fromNamespace, toNamespace]) {
    if (!namespaces.has(namespace)) throw new Error(`renames.json[${index}]: unknown namespace "${namespace}".`)
  }
  return { fromNamespace, fromKey, toNamespace, toKey }
}

const manifest = await readJson(resolve(localesRoot, 'manifest.json'), null)
if (!manifest) throw new Error('Locale manifest is missing or unreadable.')

const renames = await readJson(resolve(localesRoot, 'renames.json'), [])
if (!Array.isArray(renames)) throw new Error('renames.json must contain an array.')

if (renames.length === 0) {
  console.log('No renames pending.')
  process.exit(0)
}

const parsed = renames.map(parseEntry)
let moved = 0
let skipped = 0

for (const locale of manifest.locales) {
  if (locale.code === manifest.defaultLocale) continue

  const catalogs = new Map()
  const state = await readTranslationState(projectRoot, locale.code)
  let localeMoved = 0

  for (const { fromNamespace, fromKey, toNamespace, toKey } of parsed) {
    for (const namespace of [fromNamespace, toNamespace]) {
      if (catalogs.has(namespace)) continue
      catalogs.set(namespace, await readJson(resolve(localesRoot, locale.code, `${namespace}.json`), null))
    }
    const source = catalogs.get(fromNamespace)
    const destination = catalogs.get(toNamespace)
    if (!source || !destination) continue

    const value = getNested(source, fromKey.split('.'))
    // Idempotent: a rename already applied simply has nothing left to move.
    if (typeof value !== 'string') {
      skipped += 1
      continue
    }

    setNested(destination, toKey.split('.'), value)
    deleteNested(source, fromKey.split('.'))

    const recorded = state[fromNamespace]?.[fromKey]
    if (recorded !== undefined) {
      state[toNamespace] ??= {}
      state[toNamespace][toKey] = recorded
      delete state[fromNamespace][fromKey]
    }

    localeMoved += 1
    moved += 1
    console.log(`${locale.code}: ${fromNamespace}:${fromKey} -> ${toNamespace}:${toKey}`)
  }

  if (apply && localeMoved > 0) {
    for (const [namespace, catalog] of catalogs) {
      if (!catalog) continue
      await writeFile(
        resolve(localesRoot, locale.code, `${namespace}.json`),
        `${JSON.stringify(catalog, null, 2)}\n`,
        'utf8'
      )
    }
    await writeTranslationState(projectRoot, locale.code, state)
  }
}

console.log(
  `${apply ? 'Moved' : 'Would move'} ${moved} translation(s); ${skipped} rename(s) had nothing to move.`
)
if (!apply && moved > 0) console.log('Re-run with --apply to write the changes.')
