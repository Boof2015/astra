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
          getTracksByAlbum: async () => []
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
