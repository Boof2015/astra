import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error - plain ESM toolchain modules, intentionally untyped.
import { collectSitesFromSource, mergeContext } from './context.mjs'
// @ts-expect-error - plain ESM toolchain modules, intentionally untyped.
import { fileSlug, slug } from './slug.mjs'

const siteFor = (source: string, key: string) =>
  collectSitesFromSource('src/renderer/components/views/DemoView.tsx', source).find(
    (site: { key: string }) => site.key === key
  )

test('reads the key and namespace off a LocalizedText element', () => {
  const site = siteFor(
    `const View = () => <div><LocalizedText ns="library" i18nKey="auto.demo.hello" /></div>`,
    'auto.demo.hello'
  )
  assert.equal(site.namespace, 'library')
  assert.equal(site.file, 'src/renderer/components/views/DemoView.tsx')
  assert.equal(site.line, 1)
})

test('derives button role through generic wrappers', () => {
  // <button><span>Label</span></button> is the common shape; a role walk that stopped at the
  // span would report "text" and lose the width constraint that matters most.
  const site = siteFor(
    `const V = () => <button><span><LocalizedText ns="common" i18nKey="a.b" /></span></button>`,
    'a.b'
  )
  assert.equal(site.role, 'button')
})

test('an explicit role attribute beats the tag name', () => {
  const site = siteFor(`const V = () => <div role="button"><LocalizedText ns="common" i18nKey="a.b" /></div>`, 'a.b')
  assert.equal(site.role, 'button')
})

test('headings and body copy are distinguished', () => {
  assert.equal(siteFor(`const V = () => <h2><LocalizedText ns="common" i18nKey="a.b" /></h2>`, 'a.b').role, 'heading')
  assert.equal(siteFor(`const V = () => <p><LocalizedText ns="common" i18nKey="a.b" /></p>`, 'a.b').role, 'body')
})

test('attribute names drive the role for translate() calls', () => {
  const source = `
    const V = () => (
      <button
        aria-label={translate('common:a.aria')}
        title={translate('common:a.tip')}
        placeholder={translate('common:a.hint')}
      />
    )`
  assert.equal(siteFor(source, 'a.aria').role, 'screen-reader')
  assert.equal(siteFor(source, 'a.tip').role, 'tooltip')
  assert.equal(siteFor(source, 'a.hint').role, 'placeholder')
})

test('captures the source expression behind each placeholder', () => {
  const site = siteFor(
    `const V = () => <div>{translate('common:a.b', { count: selected.length, name })}</div>`,
    'a.b'
  )
  assert.deepEqual(site.placeholders, {
    count: { expr: 'selected.length' },
    name: { expr: 'name' },
  })
})

test('bare mainT keys fall back to the common namespace', () => {
  const sites = collectSitesFromSource('src/main/index.ts', `const title = mainT('dialogs.openAudioFile')`)
  assert.equal(sites.length, 1)
  assert.equal(sites[0].namespace, 'common')
  assert.equal(sites[0].key, 'dialogs.openAudioFile')
})

test('qualified keys keep their namespace across every helper', () => {
  const sites = collectSitesFromSource(
    'src/renderer/components/views/DemoView.tsx',
    `const a = translate('settings:x.y'); const b = t('library:z.w'); const c = mainT('errors:e.f')`
  )
  assert.deepEqual(
    sites.map((site: { namespace: string; key: string }) => `${site.namespace}:${site.key}`),
    ['settings:x.y', 'library:z.w', 'errors:e.f']
  )
})

test('siblings under one element share a container id', () => {
  const sites = collectSitesFromSource(
    'src/renderer/components/views/DemoView.tsx',
    `const V = () => <div><LocalizedText ns="common" i18nKey="a" /><LocalizedText ns="common" i18nKey="b" /></div>`
  )
  assert.equal(sites.length, 2)
  assert.equal(sites[0].containerId, sites[1].containerId)
})

test('a key built at runtime produces no site rather than a wrong one', () => {
  const sites = collectSitesFromSource('src/renderer/x.tsx', `const a = translate(dynamicKey); const b = t(\`ns:\${x}\`)`)
  assert.deepEqual(sites, [])
})

test('mergeContext preserves notes and placeholder examples, refreshes the rest', () => {
  const generated = {
    'a.b': {
      text: 'Rescan library',
      role: 'button',
      screen: 'Library',
      sites: ['src/renderer/x.tsx:10'],
      placeholders: { count: { expr: 'tracks.length' } },
      status: 'current',
    },
  }
  const existing = {
    'a.b': {
      text: 'Old text',
      role: 'text',
      screen: 'Somewhere else',
      sites: ['src/renderer/x.tsx:4'],
      placeholders: { count: { expr: 'stale', example: '128' } },
      status: 'current',
      note: 'Verb, not a noun.',
    },
  }

  const merged = mergeContext(generated, existing)
  assert.equal(merged['a.b'].note, 'Verb, not a noun.', 'hand-written notes are the point of the sidecar')
  assert.equal(merged['a.b'].placeholders.count.example, '128', 'examples are authored by hand')
  assert.equal(merged['a.b'].placeholders.count.expr, 'tracks.length', 'machine fields must refresh')
  assert.equal(merged['a.b'].role, 'button')
  assert.deepEqual(merged['a.b'].sites, ['src/renderer/x.tsx:10'])
})

test('mergeContext carries a needs-review flag forward but drops removed keys', () => {
  const merged = mergeContext(
    { keep: { text: 'a', placeholders: {}, status: 'current' } },
    { keep: { status: 'needs-review' }, gone: { note: 'orphaned' } }
  )
  assert.equal(merged.keep.status, 'needs-review')
  assert.equal(merged.gone, undefined)
})

test('slug truncates on a word boundary', () => {
  const long = 'Navigate Astra with an Xbox or PlayStation controller directly'
  const result = slug(long)
  assert.ok(result.length <= 56)
  assert.ok(!result.endsWith('_'), 'no dangling separator')
  assert.ok(!/_[a-z]$/.test(result), 'no orphaned single letter from a mid-word cut')
  assert.ok(long.toLowerCase().replace(/[^a-z0-9]+/g, '_').startsWith(result))
})

test('slug still cuts a single oversized token, and never returns empty', () => {
  assert.equal(slug('x'.repeat(80)).length, 56)
  assert.equal(slug('...'), 'text')
  assert.equal(slug(''), 'text')
})

test('fileSlug matches the extractor key segment for a component', () => {
  assert.equal(fileSlug('SettingsView.tsx'), 'settingsview')
  assert.equal(fileSlug('keyboardShortcuts.ts'), 'keyboardshortcuts')
})
