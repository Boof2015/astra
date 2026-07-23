import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '../..')
const localesRoot = resolve(projectRoot, 'src/shared/i18n/locales/en')
const entities = new Map([
  ['&apos;', "'"], ['&#39;', "'"], ['&quot;', '"'], ['&amp;', '&'],
  ['&lt;', '<'], ['&gt;', '>'], ['&nbsp;', ' '], ['&middot;', '·'],
  ['&ldquo;', '“'], ['&rdquo;', '”'], ['&lsquo;', '‘'], ['&rsquo;', '’'],
  ['&rarr;', '→'], ['&larr;', '←'], ['&times;', '×'], ['&mdash;', '—'],
])

function normalize(value) {
  if (typeof value === 'string') {
    let result = value
    for (const [entity, replacement] of entities) result = result.split(entity).join(replacement)
    return result
  }
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]))
  }
  return value
}

for (const namespace of ['common', 'settings', 'library', 'playback', 'integrations', 'errors']) {
  const path = resolve(localesRoot, `${namespace}.json`)
  const catalog = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, `${JSON.stringify(normalize(catalog), null, 2)}\n`, 'utf8')
}

