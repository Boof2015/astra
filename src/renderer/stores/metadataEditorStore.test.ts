import assert from 'node:assert/strict'
import test from 'node:test'
import { useMetadataEditorStore } from './metadataEditorStore.ts'

test('metadata editor panel request normalizes paths and skipped remote count', () => {
  useMetadataEditorStore.setState({ panelRequest: null, lastResult: null })

  useMetadataEditorStore.getState().openPanel({
    trackPaths: [' /music/a.flac ', '/music/b.flac', '/music/a.flac', ''],
    skippedRemoteCount: 2.8
  })

  const request = useMetadataEditorStore.getState().panelRequest
  assert.ok(request)
  assert.deepEqual(request.trackPaths, ['/music/a.flac', '/music/b.flac'])
  assert.equal(request.skippedRemoteCount, 2)

  useMetadataEditorStore.getState().closePanel()
  assert.equal(useMetadataEditorStore.getState().panelRequest, null)
})

test('metadata editor panel ignores empty target requests', () => {
  useMetadataEditorStore.setState({ panelRequest: null, lastResult: null })

  useMetadataEditorStore.getState().openPanel({
    trackPaths: [' ', ''],
    skippedRemoteCount: -1
  })

  assert.equal(useMetadataEditorStore.getState().panelRequest, null)
})
