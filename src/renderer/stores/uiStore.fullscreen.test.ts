import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { useLyricsEditorStore } from './lyricsEditorStore.ts'
import { useMetadataEditorStore } from './metadataEditorStore.ts'
import { useUIStore } from './uiStore.ts'

const initialUIState = useUIStore.getState()
const initialMetadataState = useMetadataEditorStore.getState()
const initialLyricsState = useLyricsEditorStore.getState()

beforeEach(() => {
  useUIStore.setState({ isFullscreen: false, isAnalyzerEditMode: false })
  useMetadataEditorStore.getState().closePanel()
  useLyricsEditorStore.getState().closePanel()
})

afterEach(() => {
  useUIStore.setState(initialUIState)
  useMetadataEditorStore.setState(initialMetadataState)
  useLyricsEditorStore.setState(initialLyricsState)
})

function openAllPanels() {
  useUIStore.getState().openAnalyzerEditMode()
  useMetadataEditorStore.getState().openPanel({ trackPaths: ['/music/track.flac'] })
  useLyricsEditorStore.getState().openPanel({ trackPaths: ['/music/track.flac'] })
}

function assertPanelsClosed() {
  assert.equal(useUIStore.getState().isAnalyzerEditMode, false)
  assert.equal(useMetadataEditorStore.getState().panelRequest, null)
  assert.equal(useLyricsEditorStore.getState().panelRequest, null)
}

for (const panel of ['analyzer', 'metadata', 'lyrics', 'all'] as const) {
  test(`fullscreen entry closes ${panel} panels and exit does not restore them`, () => {
    if (panel === 'analyzer' || panel === 'all') useUIStore.getState().openAnalyzerEditMode()
    if (panel === 'metadata' || panel === 'all') {
      useMetadataEditorStore.getState().openPanel({ trackPaths: ['/music/track.flac'] })
    }
    if (panel === 'lyrics' || panel === 'all') {
      useLyricsEditorStore.getState().openPanel({ trackPaths: ['/music/track.flac'] })
    }

    useUIStore.getState().setFullscreen(true)
    assert.equal(useUIStore.getState().isFullscreen, true)
    assertPanelsClosed()

    useUIStore.getState().setFullscreen(false)
    assert.equal(useUIStore.getState().isFullscreen, false)
    assertPanelsClosed()

    openAllPanels()
    assert.equal(useUIStore.getState().isAnalyzerEditMode, true)
    assert.ok(useMetadataEditorStore.getState().panelRequest)
    assert.ok(useLyricsEditorStore.getState().panelRequest)
  })
}

test('a rejected editor guard preserves every panel, even after another guard approves', (t) => {
  openAllPanels()
  const uiState = useUIStore.getState()
  const metadataState = useMetadataEditorStore.getState()
  const lyricsState = useLyricsEditorStore.getState()
  const checks: string[] = []

  t.after(uiState.registerFullscreenEntryGuard(() => {
    checks.push('metadata')
    return true
  }))
  t.after(uiState.registerFullscreenEntryGuard(() => {
    checks.push('lyrics')
    return false
  }))

  uiState.setFullscreen(true)

  assert.deepEqual(checks, ['metadata', 'lyrics'])
  assert.equal(useUIStore.getState(), uiState)
  assert.equal(useMetadataEditorStore.getState(), metadataState)
  assert.equal(useLyricsEditorStore.getState(), lyricsState)
})

test('a busy editor blocks entry until an explicit retry after it becomes ready', (t) => {
  openAllPanels()
  let isBusy = true
  t.after(useUIStore.getState().registerFullscreenEntryGuard(() => !isBusy))

  useUIStore.getState().setFullscreen(true)
  assert.equal(useUIStore.getState().isFullscreen, false)
  assert.ok(useMetadataEditorStore.getState().panelRequest)
  assert.ok(useLyricsEditorStore.getState().panelRequest)

  isBusy = false
  assert.equal(useUIStore.getState().isFullscreen, false)
  useUIStore.getState().setFullscreen(true)
  assert.equal(useUIStore.getState().isFullscreen, true)
  assertPanelsClosed()
})

test('fullscreen guard cleanup removes stale guards and approved entry checks each active guard', (t) => {
  openAllPanels()
  const ui = useUIStore.getState()
  const unregister = ui.registerFullscreenEntryGuard(() => false)
  t.after(unregister)
  unregister()
  unregister()

  const checks: string[] = []
  for (const editor of ['metadata', 'lyrics']) {
    t.after(ui.registerFullscreenEntryGuard(() => {
      assert.ok(useMetadataEditorStore.getState().panelRequest)
      assert.ok(useLyricsEditorStore.getState().panelRequest)
      checks.push(editor)
      return true
    }))
  }

  ui.setFullscreen(true)
  assert.equal(useUIStore.getState().isFullscreen, true)
  assertPanelsClosed()
  assert.deepEqual(checks, ['metadata', 'lyrics'])

  ui.setFullscreen(true)
  ui.setFullscreen(false)
  ui.setFullscreen(false)
  assert.deepEqual(checks, ['metadata', 'lyrics'])
  assert.equal(useUIStore.getState().isFullscreen, false)
  assertPanelsClosed()
})

test('fullscreen exit bypasses editor guards and leaves other panel state unchanged', (t) => {
  useUIStore.setState({ isFullscreen: true })
  openAllPanels()
  const metadataState = useMetadataEditorStore.getState()
  const lyricsState = useLyricsEditorStore.getState()
  t.after(useUIStore.getState().registerFullscreenEntryGuard(() => {
    assert.fail('exit must not run entry guards')
  }))

  useUIStore.getState().setFullscreen(false)

  assert.equal(useUIStore.getState().isFullscreen, false)
  assert.equal(useUIStore.getState().isAnalyzerEditMode, true)
  assert.equal(useMetadataEditorStore.getState(), metadataState)
  assert.equal(useLyricsEditorStore.getState(), lyricsState)
})
