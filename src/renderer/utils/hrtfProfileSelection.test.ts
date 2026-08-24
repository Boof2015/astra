import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SADIE_II_D1_KU100_HRTF_PROFILE_ID,
  builtinHrtfProfile,
  builtinHrtfProfiles,
  type HrtfProfileSummary,
} from '../../types/hrtfProfiles.ts'
import { resolveAvailableHrtfProfileId } from './hrtfProfileSelection.ts'

const imported: HrtfProfileSummary = {
  id: 'sofa:abc',
  name: 'Personal',
  kind: 'sofa',
  builtIn: false,
  importedAt: new Date(0).toISOString(),
  sizeBytes: 123,
}

test('startup restoration prefers a persisted imported profile over the initial built-in state', () => {
  assert.equal(
    resolveAvailableHrtfProfileId([builtinHrtfProfile(), imported], imported.id, builtinHrtfProfile().id),
    imported.id
  )
})

test('startup restoration preserves a bundled SOFA selection', () => {
  assert.equal(
    resolveAvailableHrtfProfileId(
      builtinHrtfProfiles(),
      SADIE_II_D1_KU100_HRTF_PROFILE_ID,
      builtinHrtfProfile().id
    ),
    SADIE_II_D1_KU100_HRTF_PROFILE_ID
  )
})

test('missing persisted profiles migrate to the built-in profile', () => {
  assert.equal(
    resolveAvailableHrtfProfileId([builtinHrtfProfile()], imported.id, imported.id),
    builtinHrtfProfile().id
  )
})
