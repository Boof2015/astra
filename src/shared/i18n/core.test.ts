import assert from 'node:assert/strict'
import test from 'node:test'
import i18next from 'i18next'
import {
  extractInterpolationVariables,
  formatDateForLocale,
  formatNumberForLocale,
  isLocaleStorageChange,
  normalizeLocaleCode,
  persistLocale,
  pseudoLocalizeMessage,
  readStoredLocale,
} from './core.ts'
import type { LocaleManifest } from './types.ts'

const manifest: LocaleManifest = {
  defaultLocale: 'en',
  locales: [
    { code: 'en', name: 'English', nativeName: 'English', direction: 'ltr' },
    { code: 'fr', name: 'French', nativeName: 'Français', direction: 'ltr' },
  ],
}

test('normalizeLocaleCode accepts manifest locales and falls back to English', () => {
  assert.equal(normalizeLocaleCode('fr', manifest), 'fr')
  assert.equal(normalizeLocaleCode('de', manifest), 'en')
  assert.equal(normalizeLocaleCode(null, manifest), 'en')
})

test('display locale persists and invalid stored values fall back safely', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }

  assert.equal(persistLocale(storage, 'locale', 'fr', manifest), 'fr')
  assert.equal(readStoredLocale(storage, 'locale', manifest), 'fr')
  values.set('locale', 'unsupported')
  assert.equal(readStoredLocale(storage, 'locale', manifest), 'en')
})

test('cross-window storage synchronization only reacts to the locale key', () => {
  assert.equal(isLocaleStorageChange('astra_display_language', 'astra_display_language'), true)
  assert.equal(isLocaleStorageChange('theme', 'astra_display_language'), false)
  assert.equal(isLocaleStorageChange(null, 'astra_display_language'), false)
})

test('number and date formatting honor the selected locale', () => {
  assert.equal(formatNumberForLocale('de-DE', 1234.5), '1.234,5')
  assert.equal(formatDateForLocale('en-GB', Date.UTC(2026, 6, 22), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }), '22/07/2026')
})

test('extractInterpolationVariables returns stable unique placeholder names', () => {
  assert.deepEqual(
    extractInterpolationVariables('{{count}} tracks by {{artist}} and {{ count }} more'),
    ['artist', 'count']
  )
})

test('pseudo locale expands copy without changing interpolation placeholders', () => {
  const result = pseudoLocalizeMessage('Hello, {{name}}')
  assert.match(result, /^［/)
  assert.match(result, /Hëllô/)
  assert.match(result, /{{name}}/)
  assert.deepEqual(extractInterpolationVariables(result), ['name'])
})

test('i18next falls back, interpolates, and pluralizes partial locale catalogs', async () => {
  const instance = i18next.createInstance()
  await instance.init({
    lng: 'fr',
    fallbackLng: 'en',
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    resources: {
      en: { common: {
        greeting: 'Hello, {{name}}',
        track_one: '{{count}} track',
        track_other: '{{count}} tracks',
      } },
      fr: { common: { greeting: 'Bonjour, {{name}}' } },
    },
  })

  assert.equal(instance.t('greeting', { name: 'Astra' }), 'Bonjour, Astra')
  assert.equal(instance.t('track', { count: 1 }), '1 track')
  assert.equal(instance.t('track', { count: 3 }), '3 tracks')
})
