import assert from 'node:assert/strict'
import test from 'node:test'
import { useLyricsEditorStore } from './lyricsEditorStore.ts'

test('lyrics editor panel request normalizes and de-duplicates paths', () => {
  useLyricsEditorStore.setState({ panelRequest: null })

  useLyricsEditorStore.getState().openPanel({
    trackPaths: [' /music/a.flac ', '/music/b.flac', '/music/a.flac', '']
  })

  const request = useLyricsEditorStore.getState().panelRequest
  assert.ok(request)
  assert.deepEqual(request.trackPaths, ['/music/a.flac', '/music/b.flac'])

  useLyricsEditorStore.getState().closePanel()
  assert.equal(useLyricsEditorStore.getState().panelRequest, null)
})

test('lyrics editor panel ignores empty target requests', () => {
  useLyricsEditorStore.setState({ panelRequest: null })

  useLyricsEditorStore.getState().openPanel({
    trackPaths: [' ', '']
  })

  assert.equal(useLyricsEditorStore.getState().panelRequest, null)
})
