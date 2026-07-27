import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { collectSitesFromSource, mergeContext, sortObjectByKey } from './lib/context.mjs'
import { screenFor } from './lib/screens.mjs'
import { fileSlug } from './lib/slug.mjs'

/**
 * Generates the translator context sidecars in src/shared/i18n/context/.
 *
 * They live OUTSIDE `locales/` deliberately. catalogs.ts pulls catalogs in with
 * `import.meta.glob('./locales/*​/*.json', { eager: true })`, which matches any .json in a locale
 * directory — including a sidecar. The namespace filter keeps them out of i18next's resources,
 * so nothing looks broken, but Vite still inlines the file contents and every user downloads
 * them. Sidecars named `locales/en/*.context.json` added 560KB to the renderer bundle before
 * this moved; verify-bundled-locales.mjs now fails if context ever reaches the bundle again.
 *
 *   node scripts/i18n/build-context.mjs --apply   regenerate
 *   node scripts/i18n/build-context.mjs --check   fail if the sidecars are stale
 */

const projectRoot = resolve(import.meta.dirname, '../..')
const localesRoot = resolve(projectRoot, 'src/shared/i18n/locales/en')
const contextRoot = resolve(projectRoot, 'src/shared/i18n/context')
const namespaces = ['common', 'settings', 'library', 'playback', 'integrations', 'errors']
const apply = process.argv.includes('--apply')
const check = process.argv.includes('--check')

/** How many neighbouring strings to record. Enough to disambiguate, short enough to read. */
const MAX_NEIGHBOURS = 6

const scanRoots = [
  { root: resolve(projectRoot, 'src/renderer'), extensions: /\.tsx?$/ },
  { root: resolve(projectRoot, 'src/main'), extensions: /\.ts$/ },
]

async function collectFiles(directory, extensions, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) await collectFiles(path, extensions, result)
    else if (extensions.test(entry.name) && !entry.name.includes('.test.')) result.push(path)
  }
  return result
}

function flattenCatalog(value, prefix = '', result = new Map()) {
  if (typeof value === 'string') {
    result.set(prefix, value)
    return result
  }
  if (!value || typeof value !== 'object') return result
  for (const [key, child] of Object.entries(value)) {
    flattenCatalog(child, prefix ? `${prefix}.${key}` : key, result)
  }
  return result
}

async function readJsonOrEmpty(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return {}
  }
}

const catalogs = new Map()
for (const namespace of namespaces) {
  catalogs.set(namespace, flattenCatalog(JSON.parse(await readFile(resolve(localesRoot, `${namespace}.json`), 'utf8'))))
}

// Sorted so regeneration is byte-for-byte reproducible regardless of filesystem ordering.
const files = []
for (const { root, extensions } of scanRoots) {
  files.push(...(await collectFiles(root, extensions)))
}
files.sort()

const sites = []
for (const filePath of files) {
  const relativePath = relative(projectRoot, filePath).split(sep).join('/')
  const sourceText = await readFile(filePath, 'utf8')
  // Cheap gate: parsing every renderer and main file costs real time, and most have no messages.
  if (!/LocalizedText|translate\(|[^A-Za-z]t\(|mainT\(/.test(sourceText)) continue
  sites.push(...collectSitesFromSource(relativePath, sourceText))
}

// Only sites pointing at a key that actually exists count. A `t(someVariable)` call or a key
// built at runtime resolves to nothing here, and inventing context for it would be a lie.
const resolvedSites = sites.filter((site) => catalogs.get(site.namespace)?.has(site.key))

const textOfSite = (site) => catalogs.get(site.namespace).get(site.key)

const sitesByContainer = new Map()
for (const site of resolvedSites) {
  if (!site.containerId) continue
  if (!sitesByContainer.has(site.containerId)) sitesByContainer.set(site.containerId, [])
  sitesByContainer.get(site.containerId).push(site)
}

/**
 * Neighbouring copy, which is the single most useful disambiguator a translator can get:
 * "Play" beside "Pause" and "Stop" is a verb on a button; "Play" beside "Artist" and "Album"
 * is a column heading. Both the string's own element and its parent are searched, so a button's
 * tooltip and the buttons either side of it all count as neighbours.
 */
function neighboursFor(site) {
  const own = textOfSite(site)
  const seen = new Set([own])
  const result = []
  for (const containerId of [site.containerId, site.parentContainerId]) {
    for (const candidate of sitesByContainer.get(containerId) ?? []) {
      const text = textOfSite(candidate)
      if (seen.has(text)) continue
      seen.add(text)
      result.push(text)
      if (result.length >= MAX_NEIGHBOURS) return result
    }
  }
  return result
}

/**
 * Both extractors encode the originating file in the key itself (`auto.<file>.<text>` and
 * `runtime.<file>.<property>_<text>_<hash>`), so a key with no AST site can still be traced
 * home. That matters most for the `runtime.*` block: those messages reach the UI through
 * translateSourceText()'s reverse lookup, so no call site names them and they would otherwise
 * be the single largest block of context-free strings a translator faces.
 */
const fileBySlug = new Map()
for (const filePath of files) {
  const relativePath = relative(projectRoot, filePath).split(sep).join('/')
  const slugged = fileSlug(relativePath.split('/').at(-1))
  // First writer wins so a deterministic sort decides collisions rather than scan order.
  if (!fileBySlug.has(slugged)) fileBySlug.set(slugged, relativePath)
}

/** Property name in a runtime.* key -> the role that property renders as. */
const ROLE_BY_RUNTIME_PROPERTY = {
  label: 'label',
  action: 'button',
  title: 'heading',
  description: 'body',
  message: 'body',
  placeholder: 'placeholder',
  ariaLabel: 'screen-reader',
}

function inferFromKey(key) {
  const segments = key.split('.')
  if (segments.length < 2 || (segments[0] !== 'auto' && segments[0] !== 'runtime')) return null
  const file = fileBySlug.get(segments[1])
  if (!file) return null
  const role = segments[0] === 'runtime'
    ? ROLE_BY_RUNTIME_PROPERTY[segments.at(-1).split('_')[0]] ?? 'text'
    : 'text'
  return { file, role, screen: screenFor(file) ?? 'Unmapped' }
}

/**
 * Search keyword lists are not visible copy. They exist so that typing "eq" or "lautstärke"
 * finds the right settings card, and a translator must localize the *search terms a speaker of
 * their language would actually type* rather than translate the English words one by one.
 */
function isKeywordKey(key) {
  return /^(searchKeywords|navigationKeywords)\./.test(key)
}

const entriesByNamespace = new Map(namespaces.map((namespace) => [namespace, {}]))

for (const namespace of namespaces) {
  const catalog = catalogs.get(namespace)
  const namespaceSites = resolvedSites.filter((site) => site.namespace === namespace)
  const byKey = new Map()
  for (const site of namespaceSites) {
    if (!byKey.has(site.key)) byKey.set(site.key, [])
    byKey.get(site.key).push(site)
  }

  for (const [key, text] of catalog) {
    const keySites = byKey.get(key) ?? []
    // The first site wins for role and screen. Where a string is reused across screens the
    // remaining sites are still listed, so a translator can see the reuse and judge for
    // themselves whether one wording can serve every location.
    const primary = keySites[0]
    const placeholders = {}
    for (const site of keySites) {
      for (const [name, meta] of Object.entries(site.placeholders)) placeholders[name] ??= meta
    }

    // The sentence this message sits in, with the message itself marked. Only worth storing when
    // the run actually spans more than one message — a lone label is its own run and says nothing.
    const rawRun = primary?.run ?? []
    const messagesInRun = rawRun.filter((part) => part.key).length
    const run = messagesInRun > 1
      ? rawRun.map((part) => {
        // Compare against undefined, not truthiness: an empty dynamic (an expression with no
        // meaningful name) and a whitespace literal are both falsy and would otherwise fall
        // through to the message branch and render as "undefined:undefined".
        if (part.literal !== undefined) return { literal: part.literal }
        if (part.dynamic !== undefined) return { dynamic: part.dynamic }
        const text = catalogs.get(part.namespace)?.get(part.key)
        if (text === undefined) return { dynamic: `${part.namespace}:${part.key}` }
        return part.self ? { text, self: true } : { text }
      })
      : []

    const inferred = primary ? null : inferFromKey(key)
    const role = isKeywordKey(key) ? 'keywords' : primary?.role ?? inferred?.role ?? 'text'
    const screen = primary
      ? screenFor(primary.file) ?? 'Unmapped'
      : inferred?.screen
        // Hand-written shared keys (actions.save, states.loading) are reached through variables
        // or the reverse-lookup bridge and genuinely have no single home.
        ?? 'Shared across the app'

    entriesByNamespace.get(namespace)[key] = {
      text,
      role,
      screen,
      run,
      neighbours: primary ? neighboursFor(primary) : [],
      // File paths, deliberately without line numbers. Storing the line made the sidecar churn
      // on any edit that shifted code above a call site — a one-line change near the top of
      // index.ts rewrote hundreds of entries and failed CI until regenerated, for no gain. The
      // key is unique, so grepping it finds the exact line, and the signals worth catching
      // (role, screen, neighbours) still mark the file stale on their own.
      sites: keySites.length > 0
        ? [...new Set(keySites.map((site) => site.file))]
        : inferred
          ? [inferred.file]
          : [],
      placeholders: sortObjectByKey(placeholders),
      status: 'current',
    }
  }
}

let stale = 0
for (const namespace of namespaces) {
  const path = resolve(contextRoot, `${namespace}.json`)
  const existing = await readJsonOrEmpty(path)
  const merged = sortObjectByKey(mergeContext(entriesByNamespace.get(namespace), existing))
  const serialized = `${JSON.stringify(merged, null, 2)}\n`

  if (apply) {
    await mkdir(contextRoot, { recursive: true })
    await writeFile(path, serialized, 'utf8')
    continue
  }

  let current = ''
  try {
    current = await readFile(path, 'utf8')
  } catch {
    current = ''
  }
  if (current !== serialized) {
    stale += 1
    console.error(`context/${namespace}.json is stale; run: npm run i18n:context`)
  }
}

const total = namespaces.reduce((sum, namespace) => sum + Object.keys(entriesByNamespace.get(namespace)).length, 0)
const unreferenced = namespaces.reduce(
  (sum, namespace) => sum + Object.values(entriesByNamespace.get(namespace)).filter((entry) => entry.sites.length === 0).length,
  0
)
const unmapped = namespaces.reduce(
  (sum, namespace) => sum + Object.values(entriesByNamespace.get(namespace)).filter((entry) => entry.screen === 'Unmapped').length,
  0
)

console.log(
  `${apply ? 'Wrote' : 'Checked'} context for ${total} message(s) `
    + `(${unreferenced} with no call site, ${unmapped} on an unmapped screen).`
)

// An unmapped screen is the one way context rots silently: the sidecar regenerates cleanly, so
// the staleness check passes, and the translator is left with "Unmapped" instead of a place.
// Failing here is what forces a new component to declare where it lives.
if (unmapped > 0) {
  console.error(`${unmapped} message(s) have no screen. Add a pattern to scripts/i18n/lib/screens.mjs.`)
}
if (check && (stale > 0 || unmapped > 0)) process.exitCode = 1
