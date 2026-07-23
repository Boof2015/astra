import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const projectRoot = resolve(import.meta.dirname, '../..')
const rendererRoot = resolve(projectRoot, 'src/renderer')
const localesRoot = resolve(projectRoot, 'src/shared/i18n/locales/en')
const apply = process.argv.includes('--apply')
const check = process.argv.includes('--check')
const translatedAttributes = new Set(['title', 'aria-label', 'placeholder', 'alt'])
const ignoredValues = new Set(['Astra', 'LUFS', 'dB', 'dBFS', 'Hz', 'kHz', 'ms'])
const jsxEntities = new Map([
  ['&apos;', "'"], ['&#39;', "'"], ['&quot;', '"'], ['&amp;', '&'],
  ['&lt;', '<'], ['&gt;', '>'], ['&nbsp;', ' '], ['&middot;', '·'],
  ['&ldquo;', '“'], ['&rdquo;', '”'], ['&lsquo;', '‘'], ['&rsquo;', '’'],
  ['&rarr;', '→'], ['&larr;', '←'], ['&times;', '×'], ['&mdash;', '—'],
])

function decodeJsxEntities(value) {
  let result = value
  for (const [entity, replacement] of jsxEntities) result = result.split(entity).join(replacement)
  return result
}

async function collectFiles(directory, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) await collectFiles(path, result)
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) result.push(path)
  }
  return result
}

function namespaceFor(filePath) {
  const normalized = filePath.split(sep).join('/')
  if (/components\/(settings|views\/SettingsView)/.test(normalized)) return 'settings'
  if (/components\/(library|views\/LibraryView|views\/GraphView)/.test(normalized)) return 'library'
  if (/components\/(player|queue|mini|lyrics|popout|views\/HomeView|views\/PlaylistView)/.test(normalized)) return 'playback'
  if (/components\/(parallax|sync|signal|stats)/.test(normalized)) return 'integrations'
  if (/Boundary\.tsx$/.test(normalized)) return 'errors'
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

function componentSlug(filePath) {
  return slug(basename(filePath).replace(/\.tsx$/, ''))
}

function shouldTranslate(value) {
  return /[A-Za-z]/.test(value) && !ignoredValues.has(value) && !/^https?:\/\//.test(value)
}

function relativeImport(fromFile, target) {
  let path = relative(dirname(fromFile), target).split(sep).join('/')
  if (!path.startsWith('.')) path = `./${path}`
  return path.replace(/\.tsx?$/, '')
}

function setNested(target, path, value) {
  let cursor = target
  for (let index = 0; index < path.length - 1; index += 1) {
    cursor[path[index]] ??= {}
    cursor = cursor[path[index]]
  }
  cursor[path.at(-1)] = value
}

const catalogs = {}
for (const namespace of ['common', 'settings', 'library', 'playback', 'integrations', 'errors']) {
  catalogs[namespace] = JSON.parse(await readFile(resolve(localesRoot, `${namespace}.json`), 'utf8'))
  catalogs[namespace].auto ??= {}
}

const seenKeys = new Map()
const files = await collectFiles(rendererRoot)
let extractedTextCount = 0
let extractedAttributeCount = 0

for (const filePath of files) {
  if (filePath.includes(`${sep}components${sep}i18n${sep}`)) continue
  const sourceText = await readFile(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const namespace = namespaceFor(filePath)
  const fileKey = componentSlug(filePath)
  const replacements = []
  let needsTextImport = false
  let needsTranslateImport = false

  function catalogKey(value) {
    const base = `auto.${fileKey}.${slug(value)}`
    const existing = seenKeys.get(`${namespace}:${base}`)
    let key = base
    if (existing && existing !== value) {
      key = `${base}_${createHash('sha1').update(value).digest('hex').slice(0, 7)}`
    }
    seenKeys.set(`${namespace}:${key}`, value)
    setNested(catalogs[namespace], key.split('.'), value)
    return key
  }

  function visit(node) {
    if (ts.isJsxText(node) && node.text.trim()) {
      const value = decodeJsxEntities(node.text.trim().replace(/\s+/g, ' '))
      if (shouldTranslate(value)) {
        const leading = node.text.match(/^\s*/)?.[0] ?? ''
        const trailing = node.text.match(/\s*$/)?.[0] ?? ''
        const key = catalogKey(value)
        replacements.push({
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          text: `${leading}<LocalizedText ns="${namespace}" i18nKey="${key}" />${trailing}`,
        })
        needsTextImport = true
        extractedTextCount += 1
      }
    }

    if (
      ts.isJsxAttribute(node)
      && translatedAttributes.has(node.name.text)
      && node.initializer
      && ts.isStringLiteral(node.initializer)
    ) {
      const value = decodeJsxEntities(node.initializer.text.trim().replace(/\s+/g, ' '))
      if (shouldTranslate(value)) {
        const key = catalogKey(value)
        replacements.push({
          start: node.initializer.getStart(sourceFile),
          end: node.initializer.getEnd(),
          text: `{translate('${namespace}:${key}')}`,
        })
        needsTranslateImport = true
        extractedAttributeCount += 1
      }
    }

    const isTranslatedAttributeExpression = ts.isJsxExpression(node)
      && ts.isJsxAttribute(node.parent)
      && translatedAttributes.has(node.parent.name.text)
    const isVisibleChildExpression = ts.isJsxExpression(node)
      && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    if ((isTranslatedAttributeExpression || isVisibleChildExpression) && node.expression) {
      const collectTerminals = (expression) => {
        if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
          const value = expression.text.trim().replace(/\s+/g, ' ')
          if (!shouldTranslate(value)) return
          const key = catalogKey(value)
          replacements.push({
            start: expression.getStart(sourceFile),
            end: expression.getEnd(),
            text: `translate('${namespace}:${key}')`,
          })
          needsTranslateImport = true
          extractedAttributeCount += 1
          return
        }
        if (ts.isTemplateExpression(expression)) {
          const usedNames = new Set()
          const options = []
          let value = expression.head.text
          expression.templateSpans.forEach((span, index) => {
            const preferredName = ts.isIdentifier(span.expression)
              ? span.expression.text
              : ts.isPropertyAccessExpression(span.expression)
                ? span.expression.name.text
                : `value${index + 1}`
            let name = slug(preferredName).replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase())
            if (!name || /^[0-9]/.test(name)) name = `value${index + 1}`
            while (usedNames.has(name)) name = `${name}${index + 1}`
            usedNames.add(name)
            value += `{{${name}}}${span.literal.text}`
            options.push(`${name}: ${span.expression.getText(sourceFile)}`)
          })
          if (!shouldTranslate(value)) return
          const key = catalogKey(value)
          replacements.push({
            start: expression.getStart(sourceFile),
            end: expression.getEnd(),
            text: `translate('${namespace}:${key}', { ${options.join(', ')} })`,
          })
          needsTranslateImport = true
          extractedAttributeCount += 1
          return
        }
        if (ts.isConditionalExpression(expression)) {
          collectTerminals(expression.whenTrue)
          collectTerminals(expression.whenFalse)
          return
        }
        if (ts.isParenthesizedExpression(expression)) collectTerminals(expression.expression)
      }
      collectTerminals(node.expression)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  if (replacements.length === 0) continue
  replacements.sort((left, right) => right.start - left.start)
  let updated = sourceText
  for (const replacement of replacements) {
    updated = `${updated.slice(0, replacement.start)}${replacement.text}${updated.slice(replacement.end)}`
  }

  const imports = []
  if (needsTextImport && !sourceText.includes("i18n/LocalizedText")) {
    imports.push(`import LocalizedText from '${relativeImport(filePath, resolve(rendererRoot, 'components/i18n/LocalizedText.tsx'))}'`)
  }
  const hasTranslateImport = /import\s*{[^}]*\btranslate\b[^}]*}\s*from\s*['"][^'"]*i18n['"]/.test(sourceText)
  if (needsTranslateImport && !hasTranslateImport) {
    imports.push(`import { translate } from '${relativeImport(filePath, resolve(rendererRoot, 'i18n.ts'))}'`)
  }
  if (imports.length > 0) updated = `${imports.join('\n')}\n${updated}`
  if (apply) await writeFile(filePath, updated, 'utf8')
}

if (apply) {
  for (const [namespace, catalog] of Object.entries(catalogs)) {
    await writeFile(resolve(localesRoot, `${namespace}.json`), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
  }
}

console.log(`${apply ? 'Extracted' : 'Found'} ${extractedTextCount} static text and ${extractedAttributeCount} attribute site(s).`)
if (check && (extractedTextCount > 0 || extractedAttributeCount > 0)) process.exitCode = 1
