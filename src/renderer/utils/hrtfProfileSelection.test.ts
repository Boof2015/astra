import assert from 'node:assert/strict'
import test from 'node:test'
import { builtinHrtfProfile, type HrtfProfileSummary } from '../../types/hrtfProfiles.ts'
import { resolveAvailableHrtfProfileId } from './hrtfProfileSelection.ts'

const imported: HrtfProfileSummary = {
  id: 'sofa:abc',
  name: 'Personal',
  kind: 'sofa',
  importedAt: new Date(0).toISOString(),
  sizeBytes: 123,
}

test('startup restoration prefers a persisted imported profile over the initial built-in state', () => {
  assert.equal(
    resolveAvailableHrtfProfileId([builtinHrtfProfile(), imported], imported.id, builtinHrtfProfile().id),
    imported.id
  )
})

test('missing persisted profiles migrate to the built-in profile', () => {
  assert.equal(
    resolveAvailableHrtfProfileId([builtinHrtfProfile()], imported.id, imported.id),
    builtinHrtfProfile().id
  )
})
