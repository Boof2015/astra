import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, Trans, initReactI18next } from 'react-i18next'
// @ts-expect-error - plain ESM toolchain module, intentionally untyped.
import { buildTransMessage } from './fragments.mjs'

/**
 * Proves a converted sentence still renders correctly.
 *
 * `<Trans>` refers to markup by child index, and React merges adjacent text into a single child.
 * Numbering the tags by source part instead of by rendered child produces a catalog string that
 * looks plausible, passes every static check, and then silently drops the markup at runtime.
 * Only rendering it catches that, so the conversion is verified by rendering rather than by
 * inspecting the string.
 */
async function render(message: string, children: unknown, values?: Record<string, unknown>) {
  const instance = i18next.createInstance()
  await instance.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { settings: { sample: message } } },
    defaultNS: 'settings',
    interpolation: { escapeValue: false },
  })
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: instance },
      createElement(Trans, { ns: 'settings', i18nKey: 'sample', values } as never, children as never)
    )
  )
}

test('a sentence woven through <code> keeps its markup and word order', async () => {
  const parts = [
    { namespace: 'settings', key: 'a' },
    { literal: ' ' },
    { namespace: 'settings', key: 'b', wrap: 'code' },
    { literal: ' ' },
    { namespace: 'settings', key: 'c' },
    { literal: ' ' },
    { namespace: 'settings', key: 'd', wrap: 'code' },
    { namespace: 'settings', key: 'e' },
  ]
  const texts: Record<string, string> = {
    a: 'Astra appends',
    b: '/api/get',
    c: 'and',
    d: '/api/search',
    e: '. HTTP is supported for local mirrors.',
  }
  const message = buildTransMessage(parts, (part: { key: string }) => texts[part.key])
  assert.equal(message, 'Astra appends <1>/api/get</1> and <3>/api/search</3>. HTTP is supported for local mirrors.')

  const html = await render(message, [
    'Astra appends ',
    createElement('code', { key: 'g' }, '/api/get'),
    ' and ',
    createElement('code', { key: 's' }, '/api/search'),
    '. HTTP is supported for local mirrors.',
  ])
  assert.equal(
    html,
    'Astra appends <code>/api/get</code> and <code>/api/search</code>. HTTP is supported for local mirrors.'
  )
})

test('a translation may reorder the markup freely', async () => {
  // The entire point of the conversion: a language that puts the objects first must be able to.
  const html = await render('<3>/api/search</3> と <1>/api/get</1> を付加します。', [
    'Astra appends ',
    createElement('code', { key: 'g' }, '/api/get'),
    ' and ',
    createElement('code', { key: 's' }, '/api/search'),
    '. HTTP is supported for local mirrors.',
  ])
  assert.equal(html, '<code>/api/search</code> と <code>/api/get</code> を付加します。')
})

test('a run that begins with markup numbers from zero', async () => {
  const parts = [
    { namespace: 'settings', key: 'tab', wrap: 'kbd' },
    { literal: ' ' },
    { namespace: 'settings', key: 'queue' },
  ]
  const texts: Record<string, string> = { tab: 'Tab', queue: 'queue' }
  const message = buildTransMessage(parts, (part: { key: string }) => texts[part.key])
  assert.equal(message, '<0>Tab</0> queue')

  const html = await render(message, [createElement('kbd', { key: 't' }, 'Tab'), ' queue'])
  assert.equal(html, '<kbd>Tab</kbd> queue')
})

test('numbering by part instead of by child would drop the markup', async () => {
  // Regression guard for the exact bug this test suite was written to catch: the old numbering
  // produced <2>/<6> for the sentence above, which renders as plain text with the tags stripped.
  const html = await render('Astra appends <2>/api/get</2> and <6>/api/search</6>. HTTP is supported.', [
    'Astra appends ',
    createElement('code', { key: 'g' }, '/api/get'),
    ' and ',
    createElement('code', { key: 's' }, '/api/search'),
    '. HTTP is supported.',
  ])
  assert.ok(!html.includes('<code>'), 'mis-numbered tags render without their markup')
})
