import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'
import ts from 'typescript'

const projectRoot = resolve(import.meta.dirname, '../..')
const rendererRoot = resolve(projectRoot, 'src/renderer')
const localesRoot = resolve(projectRoot, 'src/shared/i18n/locales/en')
const apply = process.argv.includes('--apply')
const check = process.argv.includes('--check')
const propertyNames = new Set(['label', 'description', 'message', 'title', 'placeholder', 'ariaLabel', 'action'])
const ignoredValues = new Set(['Astra', 'LUFS', 'dB', 'dBFS', 'Hz', 'kHz', 'ms'])

async function collectFiles(directory, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) await collectFiles(path, result)
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) result.push(path)
  }
  return result
}

function namespaceFor(filePath) {
  const normalized = filePath.split(sep).join('/')
  if (/components\/(settings|views\/SettingsView)|constants\/keyboardShortcuts|utils\/settingsTransfer/.test(normalized)) return 'settings'
  if (/components\/(library|views\/LibraryView|views\/GraphView)|stores\/libraryStore/.test(normalized)) return 'library'
  if (/components\/(player|queue|mini|lyrics|popout|playlists|views\/HomeView|views\/PlaylistView)/.test(normalized)) return 'playback'
  if (/components\/(parallax|sync|signal|stats)|stores\/(subsonic|jellyfin|parallax)/.test(normalized)) return 'integrations'
  return 'common'
}

function slug(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 56) || 'text'
}

function shouldInclude(value) {
  return /[A-Za-z]/.test(value)
    && !ignoredValues.has(value)
    && !/^https?:\/\//.test(value)
}

function setNested(target, path, value) {
  let cursor = target
  for (let index = 0; index < path.length - 1; index += 1) {
    cursor[path[index]] ??= {}
    cursor = cursor[path[index]]
  }
  cursor[path.at(-1)] = value
}

function collectCatalogValues(value, result) {
  if (typeof value === 'string') {
    result.add(value)
    return
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  for (const child of Object.values(value)) collectCatalogValues(child, result)
}

const catalogs = {}
const knownValues = new Set()
for (const namespace of ['common', 'settings', 'library', 'playback', 'integrations', 'errors']) {
  catalogs[namespace] = JSON.parse(await readFile(resolve(localesRoot, `${namespace}.json`), 'utf8'))
  catalogs[namespace].runtime ??= {}
  collectCatalogValues(catalogs[namespace], knownValues)
}

let missingCount = 0
for (const filePath of await collectFiles(rendererRoot)) {
  const normalized = filePath.split(sep).join('/')
  if (/utils\/(listeningStatsShare|listeningStatsShareCanvas|signalShareCanvas)\.ts$/.test(normalized)) continue
  const sourceText = await readFile(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const namespace = namespaceFor(filePath)
  const fileKey = slug(basename(filePath).replace(/\.tsx?$/, ''))

  function addValue(value, propertyName) {
    const normalizedValue = value.trim().replace(/\s+/g, ' ')
    if (!shouldInclude(normalizedValue) || knownValues.has(normalizedValue)) return
    missingCount += 1
    const baseKey = slug(normalizedValue)
    const hash = createHash('sha1').update(normalizedValue).digest('hex').slice(0, 7)
    setNested(catalogs[namespace], ['runtime', fileKey, `${propertyName}_${baseKey}_${hash}`], normalizedValue)
    knownValues.add(normalizedValue)
  }

  function visit(node) {
    if (ts.isPropertyAssignment(node)) {
      const propertyName = node.name.getText(sourceFile).replace(/^['"]|['"]$/g, '')
      if (
        propertyNames.has(propertyName)
        && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))
      ) {
        addValue(node.initializer.text, propertyName)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

if (apply) {
  for (const [namespace, catalog] of Object.entries(catalogs)) {
    await writeFile(resolve(localesRoot, `${namespace}.json`), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
  }
}

console.log(`${apply ? 'Extracted' : 'Found'} ${missingCount} runtime display string(s).`)
if (check && missingCount > 0) process.exitCode = 1

