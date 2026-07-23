import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '../..')
const localesRoot = resolve(projectRoot, 'src/shared/i18n/locales')
const namespaces = ['common', 'settings', 'library', 'playback', 'integrations', 'errors']

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

function placeholders(message) {
  return Array.from(message.matchAll(/{{\s*([A-Za-z0-9_.-]+)(?:\s*,[^}]*)?\s*}}/g), (match) => match[1])
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort()
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`)
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
for (const namespace of namespaces) {
  const path = resolve(localesRoot, manifest.defaultLocale, `${namespace}.json`)
  english.set(namespace, flatten(await readJson(path)))
}

let failed = false
for (const locale of manifest.locales) {
  const files = new Set(await readdir(resolve(localesRoot, locale.code)))
  let missingCount = 0
  let obsoleteCount = 0
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
    const source = english.get(namespace)
    for (const [key, sourceMessage] of source) {
      const translatedMessage = translated.get(key)
      if (translatedMessage === undefined) {
        missingCount += 1
        continue
      }
      if (/&(?:apos|quot|amp|lt|gt|nbsp|middot|ldquo|rdquo|lsquo|rsquo|rarr|larr|times|mdash);|&#39;/.test(translatedMessage)) {
        console.error(`${locale.code}/${namespace}:${key} contains an HTML entity; use the Unicode character in JSON.`)
        failed = true
      }
      const expected = placeholders(sourceMessage)
      const actual = placeholders(translatedMessage)
      if (expected.join('\0') !== actual.join('\0')) {
        console.error(`${locale.code}/${namespace}:${key} placeholder mismatch (${expected.join(', ')} != ${actual.join(', ')})`)
        failed = true
      }
    }
    for (const key of translated.keys()) {
      if (!source.has(key)) obsoleteCount += 1
    }
  }
  console.log(`${locale.code}: ${missingCount} missing, ${obsoleteCount} obsolete key(s)`)
}

if (failed) process.exitCode = 1
