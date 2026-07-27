import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { checkMessage } from './lib/rules.mjs'
import { writeTranslationState } from './lib/state.mjs'

/**
 * Unpacks a bundle exported by the offline workbench into the repo.
 *
 * The translator's half of the loop is one file in and one file out. This is the maintainer's
 * half: it writes the locale catalogs, records the English each string was translated from, and
 * re-runs the same checks the workbench already showed the translator, so nothing lands that
 * would fail CI.
 *
 *   node scripts/i18n/import-translation.mjs astra-de.json
 *   node scripts/i18n/import-translation.mjs astra-de.json --apply
 */

const projectRoot = resolve(import.meta.dirname, '../..')
const localesRoot = resolve(projectRoot, 'src/shared/i18n/locales')
const contextRoot = resolve(projectRoot, 'src/shared/i18n/context')
const namespaces = new Set(['common', 'settings', 'library', 'playback', 'integrations', 'errors'])
const apply = process.argv.includes('--apply')
const bundlePath = process.argv.slice(2).find((argument) => !argument.startsWith('--'))

if (!bundlePath) {
  console.error('Usage: node scripts/i18n/import-translation.mjs <bundle.json> [--apply]')
  process.exit(1)
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

const bundle = JSON.parse(await readFile(resolve(process.cwd(), bundlePath), 'utf8'))
if (!bundle?.astraTranslationBundle || !bundle.locale?.code) {
  throw new Error('That file is not an Astra translation bundle.')
}

const localeCode = bundle.locale.code
const manifest = JSON.parse(await readFile(resolve(localesRoot, 'manifest.json'), 'utf8'))
if (localeCode === manifest.defaultLocale) throw new Error(`${localeCode} is the source locale.`)

const context = new Map()
const english = new Map()
for (const namespace of namespaces) {
  english.set(namespace, flatten(JSON.parse(await readFile(resolve(localesRoot, manifest.defaultLocale, `${namespace}.json`), 'utf8')), '', new Map()))
  try {
    context.set(namespace, JSON.parse(await readFile(resolve(contextRoot, `${namespace}.json`), 'utf8')))
  } catch {
    context.set(namespace, {})
  }
}

let imported = 0
let rejected = 0
let warned = 0
let unknown = 0
const catalogs = new Map()
const translatedFrom = {}

for (const [namespace, tree] of Object.entries(bundle.namespaces ?? {})) {
  if (!namespaces.has(namespace)) {
    console.error(`Unknown namespace "${namespace}" in the bundle; skipping.`)
    continue
  }
  const source = english.get(namespace)
  const namespaceContext = context.get(namespace) ?? {}
  const catalog = {}
  translatedFrom[namespace] = {}

  for (const [key, value] of flatten(tree, '', new Map())) {
    const sourceMessage = source.get(key)
    if (sourceMessage === undefined) {
      // A key the English catalog no longer has. Dropping it keeps the locale file clean rather
      // than carrying a translation nothing can ever render.
      unknown += 1
      continue
    }
    const { errors, warnings } = checkMessage(sourceMessage, value, { role: namespaceContext[key]?.role })
    if (errors.length > 0) {
      rejected += 1
      for (const message of errors) console.error(`${namespace}:${key} ${message}`)
      continue
    }
    for (const message of warnings) {
      warned += 1
      console.warn(`${namespace}:${key} ${message}`)
    }
    setNested(catalog, key.split('.'), value)
    // Prefer the English the translator actually saw; fall back to today's if the bundle is old.
    translatedFrom[namespace][key] = bundle.translatedFrom?.[namespace]?.[key] ?? sourceMessage
    imported += 1
  }

  if (Object.keys(catalog).length > 0) catalogs.set(namespace, catalog)
}

if (apply && rejected === 0) {
  await mkdir(resolve(localesRoot, localeCode), { recursive: true })
  for (const [namespace, catalog] of catalogs) {
    await writeFile(resolve(localesRoot, localeCode, `${namespace}.json`), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
  }
  await writeTranslationState(projectRoot, localeCode, translatedFrom)
}

console.log(
  `${apply && rejected === 0 ? 'Imported' : 'Would import'} ${imported} translation(s) for ${localeCode} `
    + `across ${catalogs.size} namespace(s); ${rejected} rejected, ${warned} length warning(s), `
    + `${unknown} obsolete key(s) dropped.`
)

if (rejected > 0) {
  console.error('Nothing was written. Fix the errors above in the workbench and re-export.')
  process.exitCode = 1
} else if (!apply) {
  console.log('Re-run with --apply to write the files.')
} else if (!manifest.locales.some((locale) => locale.code === localeCode)) {
  console.log(
    `\nAdd ${localeCode} to src/shared/i18n/locales/manifest.json to make it selectable:\n`
      + `  { "code": "${localeCode}", "name": "${bundle.locale.name ?? localeCode}", `
      + `"nativeName": "${bundle.locale.nativeName ?? localeCode}", "direction": "${bundle.locale.direction ?? 'ltr'}" }`
  )
}
