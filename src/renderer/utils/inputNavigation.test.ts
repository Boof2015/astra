import test from 'node:test'
import assert from 'node:assert/strict'
import { useLibraryStore } from '../stores/libraryStore.ts'
import { useUIStore } from '../stores/uiStore.ts'
import { navigateInputBack, navigateInputForward } from './inputNavigation.ts'

function installNavigationMock(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        library: {
          getTracksByArtist: async () => [],
          getTracksByAlbum: async () => [],
          getTracksByGenre: async () => []
        }
      }
    }
  })
}

test('combined navigation returns Home-origin Library details and restores them with Forward', async () => {
  installNavigationMock()
  useUIStore.setState({
    activeView: 'library',
    viewBackHistory: ['home'],
    viewForwardHistory: []
  })
  useLibraryStore.setState({
    viewMode: 'artists',
    selectedAlbum: null,
    selectedArtist: 'Artist A',
    selectedGenre: null,
    selectedYear: null,
    selectionOrigin: 'home',
    selectionHistory: [],
    selectionForwardHistory: [],
    trackPaths: [],
    fullTrackPaths: [],
    trackByPath: new Map()
  })

  assert.equal(await navigateInputBack(), true)
  assert.equal(useUIStore.getState().activeView, 'home')
  assert.equal(useLibraryStore.getState().selectedArtist, null)
  assert.deepEqual(useUIStore.getState().viewForwardHistory, ['library'])

  assert.equal(await navigateInputForward(), true)
  assert.equal(useUIStore.getState().activeView, 'library')
  assert.equal(useLibraryStore.getState().selectedArtist, 'Artist A')
})

test('global Back continues to traverse Library detail history', async () => {
  installNavigationMock()
  useUIStore.setState({
    activeView: 'library',
    viewBackHistory: [],
    viewForwardHistory: []
  })
  useLibraryStore.setState({
    viewMode: 'tracks',
    selectedAlbum: null,
    selectedArtist: null,
    selectedGenre: null,
    selectedYear: null,
    selectionOrigin: null,
    selectionHistory: [],
    selectionForwardHistory: [],
    trackPaths: [],
    fullTrackPaths: [],
    trackByPath: new Map()
  })

  await useLibraryStore.getState().selectArtist('Artist A')
  await useLibraryStore.getState().selectArtist('Artist B')

  assert.equal(await navigateInputBack(), true)
  assert.equal(useUIStore.getState().activeView, 'library')
  assert.equal(useLibraryStore.getState().selectedArtist, 'Artist A')
  assert.equal(useLibraryStore.getState().selectionForwardHistory.length, 1)
})

test('Library genre detail back returns to Genres root', async () => {
  installNavigationMock()
  useUIStore.setState({
    activeView: 'library',
    viewBackHistory: [],
    viewForwardHistory: []
  })
  useLibraryStore.setState({
    viewMode: 'genres',
    selectedAlbum: null,
    selectedArtist: null,
    selectedGenre: 'Electronic',
    selectedYear: null,
    selectionOrigin: 'library',
    selectionHistory: [],
    selectionForwardHistory: [],
    trackPaths: ['/music/a.flac'],
    fullTrackPaths: ['/music/a.flac', '/music/b.flac'],
    trackByPath: new Map()
  })

  assert.equal(await navigateInputBack(), true)
  assert.equal(useUIStore.getState().activeView, 'library')
  assert.equal(useLibraryStore.getState().selectedGenre, null)
  assert.deepEqual(useLibraryStore.getState().trackPaths, ['/music/a.flac', '/music/b.flac'])
  assert.equal(useLibraryStore.getState().selectionForwardHistory.length, 1)
})

test('Library year detail back returns to Years root', async () => {
  installNavigationMock()
  useUIStore.setState({
    activeView: 'library',
    viewBackHistory: [],
    viewForwardHistory: []
  })
  useLibraryStore.setState({
    viewMode: 'years',
    selectedAlbum: null,
    selectedArtist: null,
    selectedGenre: null,
    selectedYear: 'unknown',
    selectionOrigin: 'library',
    selectionHistory: [],
    selectionForwardHistory: [],
    trackPaths: [],
    fullTrackPaths: [],
    trackByPath: new Map()
  })

  assert.equal(await navigateInputBack(), true)
  assert.equal(useUIStore.getState().activeView, 'library')
  assert.equal(useLibraryStore.getState().selectedYear, null)
  assert.equal(useLibraryStore.getState().selectionForwardHistory.length, 1)
})
