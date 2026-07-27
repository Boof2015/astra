import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

// Catalogs are pulled in with import.meta.glob, which is a build-time transform: if the call is
// ever guarded, reshaped, or dropped, the bundle still builds and every message silently renders
// as its key. The locale JSON is only trustworthy once it is proven to be inside the output.
//
// The default locale is also imported statically as a safety net, so its presence alone does not
// prove the glob still works. Every additional locale reaches the bundle through the glob and
// nothing else, which is why each one is checked separately.

const projectRoot = resolve(import.meta.dirname, '../..')
const localesRoot = resolve(projectRoot, 'src/shared/i18n/locales')
const outRoot = resolve(projectRoot, 'out')
const namespaces = ['common', 'settings', 'library', 'playback', 'integrations', 'errors']

function collectCandidates(value, prefix = '', result = []) {
  if (typeof value === 'string') {
    // ASCII messages survive minification verbatim; placeholders are interpolated, so a
    // literal match on them would be meaningless.
    if (value.length >= 20 && /^[\x20-\x7e]+$/.test(value) && !value.includes('{{')) {
      result.push({ key: prefix, message: value })
    }
    return result
  }
  if (!value || typeof value !== 'object') return result
  for (const [key, child] of Object.entries(value)) {
    collectCandidates(child, prefix ? `${prefix}.${key}` : key, result)
  }
  return result
}

// A sentinel is only meaningful if this catalog is its sole origin: a message that also exists as
// a source literal (or, for a translation, that was left in English) would be bundled either way,
// and the check would pass on an empty catalog. Longest first, so the accepted sentinel is also
// the least collision-prone; deterministic order keeps failures reproducible.
function pickSentinel(catalog, ...excluded) {
  return collectCandidates(catalog)
    .sort((left, right) => right.message.length - left.message.length || left.key.localeCompare(right.key))
    .find((candidate) => excluded.every((haystack) => !haystack.has(candidate.message))) ?? null
}

async function readSourceText(directory, chunks = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (path === localesRoot) continue
    if (entry.isDirectory()) await readSourceText(path, chunks)
    else if (/\.(ts|tsx)$/.test(entry.name)) chunks.push(await readFile(path, 'utf8'))
  }
  return chunks
}

async function readBundle(label, files) {
  if (files.length === 0) throw new Error(`${label}: no bundle found under out/ — run npm run build first.`)
  return (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')
}

async function rendererBundleFiles() {
  const assets = resolve(outRoot, 'renderer/assets')
  try {
    return (await readdir(assets)).filter((name) => name.endsWith('.js')).map((name) => resolve(assets, name))
  } catch {
    return []
  }
}

async function readCatalog(locale, namespace) {
  try {
    return JSON.parse(await readFile(resolve(localesRoot, locale, `${namespace}.json`), 'utf8'))
  } catch {
    return null
  }
}

const manifest = JSON.parse(await readFile(resolve(localesRoot, 'manifest.json'), 'utf8'))
const sourceText = (await readSourceText(resolve(projectRoot, 'src'))).join('\n')
const inSource = { has: (message) => sourceText.includes(message) }

const defaultMessages = new Set()
for (const namespace of namespaces) {
  const catalog = await readCatalog(manifest.defaultLocale, namespace)
  if (catalog) for (const { message } of collectCandidates(catalog)) defaultMessages.add(message)
}

const sentinels = []
for (const locale of manifest.locales) {
  const isDefault = locale.code === manifest.defaultLocale
  let localeSentinels = 0
  for (const namespace of namespaces) {
    const catalog = await readCatalog(locale.code, namespace)
    // Partial translations are supported: a locale only has to ship the namespaces it translated.
    if (!catalog) continue
    // A translated message that still reads as English proves nothing, so it cannot be a sentinel.
    const sentinel = pickSentinel(catalog, inSource, ...(isDefault ? [] : [defaultMessages]))
    if (!sentinel) continue
    localeSentinels += 1
    sentinels.push({ locale: locale.code, namespace, ...sentinel })
  }
  if (localeSentinels === 0) {
    console.error(`${locale.code}: no catalog-only message usable as a bundle sentinel.`)
    process.exitCode = 1
  }
}

const bundles = [
  { label: 'renderer', source: await readBundle('renderer', await rendererBundleFiles()) },
  { label: 'main', source: await readBundle('main', [resolve(outRoot, 'main/index.js')]) },
]

for (const bundle of bundles) {
  const missing = sentinels.filter((sentinel) => !bundle.source.includes(sentinel.message))
  if (missing.length === 0) {
    console.log(`${bundle.label}: ${sentinels.length} catalog(s) present in the bundle.`)
    continue
  }
  process.exitCode = 1
  for (const sentinel of missing) {
    console.error(`${bundle.label}: ${sentinel.locale}/${sentinel.namespace}:${sentinel.key} is missing from the bundle.`)
  }
  console.error(`${bundle.label}: locale catalogs did not reach the bundle, so those messages would render as their keys.`)
}

// The mirror image of the check above: translator context must stay OUT of the bundle. The glob
// that pulls in catalogs matches any .json inside a locale directory, so a sidecar parked next to
// them is silently inlined and shipped — 560KB of screens, notes and source paths downloaded by
// every user, with nothing visibly broken to notice. Context lives in src/shared/i18n/context/
// for exactly this reason, and this makes moving it back a build failure rather than a surprise.
const CONTEXT_MARKERS = ['"neighbours"', 'Transport bar (bottom of the main window)']
for (const bundle of bundles) {
  const leaked = CONTEXT_MARKERS.filter((marker) => bundle.source.includes(marker))
  if (leaked.length === 0) continue
  process.exitCode = 1
  console.error(
    `${bundle.label}: translator context reached the bundle (${leaked.join(', ')}). `
      + 'Context belongs in src/shared/i18n/context/, outside the locales glob in catalogs.ts.'
  )
}
