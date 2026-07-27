import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { checkMessage } from './lib/rules.mjs'
import { findStaleTranslations, readTranslationState } from './lib/state.mjs'

const projectRoot = resolve(import.meta.dirname, '../..')
const localesRoot = resolve(projectRoot, 'src/shared/i18n/locales')
const namespaces = ['common', 'settings', 'library', 'playback', 'integrations', 'errors']

/** Enough to act on without burying the summary line under a wall of text. */
const STALE_REPORT_LIMIT = 20

function flatten(value, prefix = '', result = new Map()) {
  if (typeof value === 'string') {
    result.set(prefix, value)
    return result
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Catalog value at ${prefix || '<root>'} must be a string or object.`)
  }
  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, result)
  }
  return result
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Context sidecars supply the element role behind each message, which is what turns a raw
 * character count into a meaningful width warning. They are optional here on purpose: a
 * namespace with no sidecar still validates, it just carries no length advice.
 */
async function readContext(namespace) {
  try {
    return await readJson(resolve(projectRoot, 'src/shared/i18n/context', `${namespace}.json`))
  } catch {
    return {}
  }
}

const manifest = await readJson(resolve(localesRoot, 'manifest.json'))
if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.locales)) {
  throw new Error('Locale manifest must contain a locales array.')
}

const localeCodes = new Set()
for (const locale of manifest.locales) {
  if (!locale || typeof locale !== 'object') throw new Error('Each locale manifest entry must be an object.')
  const { code, name, nativeName, direction } = locale
  if (typeof code !== 'string' || !code) throw new Error('Every locale must have a code.')
  try {
    if (Intl.getCanonicalLocales(code)[0] !== code) throw new Error('not canonical')
  } catch {
    throw new Error(`Locale code ${code} must be a canonical BCP 47 language tag.`)
  }
  if (localeCodes.has(code)) throw new Error(`Duplicate locale code: ${code}`)
  if (typeof name !== 'string' || !name || typeof nativeName !== 'string' || !nativeName) {
    throw new Error(`Locale ${code} must define name and nativeName.`)
  }
  if (direction !== 'ltr' && direction !== 'rtl') throw new Error(`Locale ${code} has an invalid direction.`)
  localeCodes.add(code)
}

if (!localeCodes.has(manifest.defaultLocale)) {
  throw new Error('The manifest defaultLocale must reference a listed locale.')
}

const english = new Map()
const context = new Map()
for (const namespace of namespaces) {
  const path = resolve(localesRoot, manifest.defaultLocale, `${namespace}.json`)
  english.set(namespace, flatten(await readJson(path)))
  context.set(namespace, await readContext(namespace))
}

let failed = false
for (const locale of manifest.locales) {
  const files = new Set(await readdir(resolve(localesRoot, locale.code)))
  const translatedByNamespace = new Map()
  let missingCount = 0
  let obsoleteCount = 0
  let warningCount = 0
  for (const namespace of namespaces) {
    const fileName = `${namespace}.json`
    if (!files.has(fileName)) {
      if (locale.code === manifest.defaultLocale) {
        console.error(`${locale.code}: missing required ${fileName}`)
        failed = true
      } else {
        missingCount += english.get(namespace).size
      }
      continue
    }
    const translated = flatten(await readJson(resolve(localesRoot, locale.code, fileName)))
    translatedByNamespace.set(namespace, translated)
    const source = english.get(namespace)
    const namespaceContext = context.get(namespace) ?? {}
    for (const [key, sourceMessage] of source) {
      const translatedMessage = translated.get(key)
      if (translatedMessage === undefined) {
        missingCount += 1
        continue
      }
      const { errors, warnings } = checkMessage(sourceMessage, translatedMessage, {
        role: namespaceContext[key]?.role,
      })
      for (const message of errors) {
        console.error(`${locale.code}/${namespace}:${key} ${message}`)
        failed = true
      }
      // Advisory: width is a judgement call the translator already saw in the workbench, and
      // failing on it would only teach contributors to tune out this validator.
      for (const message of warnings) {
        console.warn(`${locale.code}/${namespace}:${key} ${message}`)
        warningCount += 1
      }
    }
    for (const key of translated.keys()) {
      if (!source.has(key)) obsoleteCount += 1
    }
  }
  // A translation whose English has since been rewritten is structurally perfect and silently
  // wrong, so it is invisible to every other check here.
  let staleCount = 0
  if (locale.code !== manifest.defaultLocale) {
    const stale = findStaleTranslations(
      await readTranslationState(projectRoot, locale.code),
      english,
      translatedByNamespace
    )
    staleCount = stale.length
    for (const entry of stale.slice(0, STALE_REPORT_LIMIT)) {
      console.warn(
        `${locale.code}/${entry.namespace}:${entry.key} was translated from `
          + `${JSON.stringify(entry.was)} but English now reads ${JSON.stringify(entry.now)}.`
      )
    }
    if (staleCount > STALE_REPORT_LIMIT) {
      console.warn(`${locale.code}: ${staleCount - STALE_REPORT_LIMIT} more stale translation(s) not listed.`)
    }
  }

  const notes = [
    warningCount > 0 ? `${warningCount} length warning(s)` : null,
    staleCount > 0 ? `${staleCount} stale translation(s)` : null,
  ].filter(Boolean)
  const suffix = notes.length > 0 ? `, ${notes.join(', ')}` : ''
  console.log(`${locale.code}: ${missingCount} missing, ${obsoleteCount} obsolete key(s)${suffix}`)
}

if (failed) process.exitCode = 1
