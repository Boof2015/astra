import test from 'node:test'
import assert from 'node:assert/strict'
import { useLibraryStore } from './libraryStore.ts'

function installLibraryMock(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        library: {
          getTracksByArtist: async () => [],
          getTracksByAlbum: async () => []
        }
      }
    }
  })
}

function resetLibraryNavigation(): void {
  useLibraryStore.setState({
    viewMode: 'albums',
    selectedAlbum: null,
    selectedArtist: null,
    selectionOrigin: null,
    selectionHistory: [],
    selectionForwardHistory: [],
    trackPaths: [],
    fullTrackPaths: [],
    trackByPath: new Map()
  })
}

test('Library detail navigation traverses backward and forward', async () => {
  installLibraryMock()
  resetLibraryNavigation()

  await useLibraryStore.getState().selectArtist('Artist A')
  await useLibraryStore.getState().selectAlbum('Album B', 'Artist B')

  assert.equal(useLibraryStore.getState().selectedAlbum?.album, 'Album B')
  assert.equal(await useLibraryStore.getState().goBackSelection(), true)
  assert.equal(useLibraryStore.getState().selectedArtist, 'Artist A')
  assert.equal(useLibraryStore.getState().selectionForwardHistory.length, 1)

  assert.equal(await useLibraryStore.getState().goForwardSelection(), true)
  assert.equal(useLibraryStore.getState().selectedAlbum?.album, 'Album B')
  assert.equal(useLibraryStore.getState().selectionHistory.length, 1)
})

test('Library root participates in forward navigation and fresh selection clears forward history', async () => {
  installLibraryMock()
  resetLibraryNavigation()

  await useLibraryStore.getState().selectArtist('Artist A')
  assert.equal(await useLibraryStore.getState().goBackSelection(), true)
  assert.equal(useLibraryStore.getState().selectedArtist, null)
  assert.equal(useLibraryStore.getState().selectionForwardHistory.length, 1)

  assert.equal(await useLibraryStore.getState().goForwardSelection(), true)
  assert.equal(useLibraryStore.getState().selectedArtist, 'Artist A')

  await useLibraryStore.getState().goBackSelection()
  await useLibraryStore.getState().selectArtist('Artist C')
  assert.equal(useLibraryStore.getState().selectionForwardHistory.length, 0)
  assert.equal(await useLibraryStore.getState().goForwardSelection(), false)
})
