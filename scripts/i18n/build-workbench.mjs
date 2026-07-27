import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readTranslationState } from './lib/state.mjs'
import { WORKBENCH_CSS, WORKBENCH_JS } from './lib/workbench-ui.mjs'

/**
 * Builds a self-contained translation workbench for one locale.
 *
 * This is Astra's answer to Crowdin. A translator gets one HTML file: no account, no server, no
 * network, no toolchain. They open it in any browser, work through the strings with the same
 * context the repo has, and send back one JSON file.
 *
 * The validation rules are inlined from lib/rules.mjs rather than reimplemented, so the
 * workbench and CI cannot disagree about what is acceptable. A translator being told their work
 * is fine and then having CI reject it is the exact failure this whole design exists to avoid.
 *
 *   node scripts/i18n/build-workbench.mjs --locale=de
 */

const projectRoot = resolve(import.meta.dirname, '../..')
const localesRoot = resolve(projectRoot, 'src/shared/i18n/locales')
const contextRoot = resolve(projectRoot, 'src/shared/i18n/context')
const namespaces = ['common', 'settings', 'library', 'playback', 'integrations', 'errors']

const localeArgument = process.argv.find((argument) => argument.startsWith('--locale='))
const outArgument = process.argv.find((argument) => argument.startsWith('--out='))
if (!localeArgument) {
  console.error('Usage: node scripts/i18n/build-workbench.mjs --locale=<code> [--out=<file>]')
  process.exit(1)
}
const localeCode = localeArgument.slice('--locale='.length)

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

function flatten(value, prefix, result) {
  if (typeof value === 'string') {
    result.set(prefix, value)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, result)
}

const manifest = await readJson(resolve(localesRoot, 'manifest.json'))
if (!manifest) throw new Error('Locale manifest is missing or unreadable.')

/** Names an unregistered locale from ICU so the workbench header reads "Deutsch", not "de". */
function describeLocale(code) {
  const display = (locale) => {
    try {
      return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code
    } catch {
      return code
    }
  }
  let direction = 'ltr'
  try {
    // getTextInfo is the current spec; textInfo was the earlier shape. Neither is universal yet.
    const info = new Intl.Locale(code)
    direction = (info.getTextInfo?.() ?? info.textInfo)?.direction ?? 'ltr'
  } catch {
    direction = 'ltr'
  }
  return { code, name: display('en'), nativeName: display(code), direction }
}

// A locale that is not in the manifest yet is the normal case: you build a workbench in order to
// produce the first translation, and only then add the manifest entry.
const localeEntry = manifest.locales.find((locale) => locale.code === localeCode) ?? describeLocale(localeCode)
if (localeCode === manifest.defaultLocale) {
  console.error(`${localeCode} is the source locale; there is nothing to translate into it.`)
  process.exit(1)
}

const translationState = await readTranslationState(projectRoot, localeCode)

const messages = []
for (const namespace of namespaces) {
  const english = new Map()
  flatten(await readJson(resolve(localesRoot, manifest.defaultLocale, `${namespace}.json`), {}), '', english)

  const context = await readJson(resolve(contextRoot, `${namespace}.json`), {})
  const existing = new Map()
  flatten(await readJson(resolve(localesRoot, localeCode, `${namespace}.json`), {}), '', existing)
  const recorded = translationState[namespace] ?? {}

  for (const [key, text] of english) {
    const entry = context[key] ?? {}
    const translatedFrom = recorded[key]
    messages.push({
      ns: namespace,
      key,
      text,
      role: entry.role ?? 'text',
      screen: entry.screen ?? 'Unmapped',
      run: entry.run ?? [],
      neighbours: entry.neighbours ?? [],
      placeholders: entry.placeholders ?? {},
      sites: entry.sites ?? [],
      note: entry.note,
      status: entry.status,
      existing: existing.get(key),
      // Only stale if it was translated from English that has since changed.
      staleFrom: translatedFrom !== undefined && translatedFrom !== text ? translatedFrom : undefined,
    })
  }
}

// Group by screen so a translator can work through one part of the app at a time, which is the
// only way the neighbouring-strings context is actually useful.
const screenOrder = new Map()
for (const message of messages) {
  if (!screenOrder.has(message.screen)) screenOrder.set(message.screen, screenOrder.size)
}
messages.sort((left, right) => {
  const byScreen = screenOrder.get(left.screen) - screenOrder.get(right.screen)
  if (byScreen !== 0) return byScreen
  return left.ns === right.ns ? (left.key < right.key ? -1 : 1) : left.ns < right.ns ? -1 : 1
})

// Seed the draft from any translation already in the repo so the workbench opens on real work
// in progress rather than a blank slate.
const seeded = messages.filter((message) => message.existing !== undefined).length

const rulesSource = (await readFile(resolve(import.meta.dirname, 'lib/rules.mjs'), 'utf8'))
  .replace(/^export /gm, '')

const data = {
  locale: localeEntry,
  generatedAt: new Date().toISOString(),
  messages: messages.map(({ existing, ...rest }) => rest),
  seed: Object.fromEntries(
    messages.filter((message) => message.existing !== undefined).map((message) => [`${message.ns}:${message.key}`, message.existing])
  ),
}

/** `</script>` inside a JSON string would end the block early; escaping `<` prevents that. */
const serializedData = JSON.stringify(data).replace(/</g, '\\u003c')

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Astra translation — ${localeEntry.nativeName}</title>
<style>${WORKBENCH_CSS}</style>
</head>
<body>
<header>
  <h1>Astra <small>${localeEntry.nativeName} (${localeEntry.code})</small></h1>
  <div class="progress"><i id="bar"></i></div>
  <span class="count" id="count"></span>
  <select id="filter" aria-label="Filter strings">
    <option value="all">All strings</option>
    <option value="todo">Not translated</option>
    <option value="review">Needs review</option>
    <option value="problem">Has a problem</option>
  </select>
  <input type="search" id="search" placeholder="Search…" aria-label="Search strings">
  <button id="import">Import…</button>
  <button id="export" class="primary">Export</button>
  <span class="count" id="status"></span>
</header>
<main>
  <div id="list" role="listbox" aria-label="Strings"></div>
  <div id="detail" class="empty">Select a string</div>
</main>
<script>
${rulesSource}
const DATA = ${serializedData};
// Translations already in the repo become the starting draft, unless this browser already holds
// newer local work for the same locale.
(function seedDraft() {
  var key = 'astra-i18n-workbench-' + DATA.locale.code
  try {
    if (!localStorage.getItem(key) && Object.keys(DATA.seed).length) {
      localStorage.setItem(key, JSON.stringify(DATA.seed))
    }
  } catch (error) { /* private browsing; the workbench still works, it just cannot persist. */ }
})();
${WORKBENCH_JS}
</script>
</body>
</html>
`

const outputPath = outArgument
  ? resolve(projectRoot, outArgument.slice('--out='.length))
  : resolve(projectRoot, 'dist/i18n', `astra-translate-${localeCode}.html`)

await mkdir(resolve(outputPath, '..'), { recursive: true })
await writeFile(outputPath, html, 'utf8')

const stale = messages.filter((message) => message.staleFrom).length
console.log(
  `Wrote ${outputPath.slice(projectRoot.length + 1)} `
    + `(${messages.length} messages, ${seeded} already translated, ${stale} stale, `
    + `${Math.round(html.length / 1024)}KB, no network required).`
)
