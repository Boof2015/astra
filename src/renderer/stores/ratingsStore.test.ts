import assert from 'node:assert/strict'
import test from 'node:test'
import { useRatingsStore } from './ratingsStore.ts'
import { useServerNoticeStore } from './serverNoticeStore.ts'
import { SETTINGS_TRANSFER_CATEGORY_STORAGE_KEYS } from '../utils/settingsTransfer.ts'

test('rating preferences are loaded from main and file-write permission is never stored in localStorage', async t => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>()
  let preference = { enabled: true, writeToFiles: false }
  let writes = 0
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { library: {
    getRatingPreferences: async () => preference,
    setRatingPreferences: async (value: typeof preference) => { writes++; preference = value; return value }
  } } } })
  t.after(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
    else Reflect.deleteProperty(globalThis, 'window')
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  useRatingsStore.setState({ preferencesBusy: false, preferencesReady: false, writeToFiles: false, enabled: false })
  await useRatingsStore.getState().loadPreferences()
  assert.equal(useRatingsStore.getState().enabled, true)
  await useRatingsStore.getState().setWriteToFiles(true)
  assert.deepEqual(preference, { enabled: true, writeToFiles: true })
  assert.equal(writes, 1)
  assert.deepEqual([...values.keys()], ['astra-library-track-ratings-enabled-v1'])
  assert.ok(Object.values(SETTINGS_TRANSFER_CATEGORY_STORAGE_KEYS).flat().every(key => !/write.*rating|rating.*write/i.test(key)))
  await useRatingsStore.getState().setEnabled(false)
  assert.deepEqual(preference, { enabled: false, writeToFiles: true })
})

test('file failures preserve optimistic ratings and expose all affected paths', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const failures = [{ path: '/music/old.mp3', message: 'Unsupported older tags' }]
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { library: {
    setTrackRating: async () => ({ filesWritten: [], fileFailures: failures })
  } } } })
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  useRatingsStore.setState({ ratings: new Map(), fileFailures: [] })
  useServerNoticeStore.setState({ queue: [] })
  await useRatingsStore.getState().setTrackRating(['/music/old.mp3'], 4.5)
  assert.equal(useRatingsStore.getState().ratings.get('/music/old.mp3')?.rating, 4.5)
  assert.deepEqual(useRatingsStore.getState().fileFailures, failures)
  assert.match(useServerNoticeStore.getState().queue[0].message ?? '', /saved in Astra/)
})
