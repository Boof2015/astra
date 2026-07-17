import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPlayableOccurrenceIndexes } from './playlistOccurrences.ts'

test('duplicate playlist occurrences keep distinct playable queue indexes', () => {
  const occurrences = [
    { path: '/music/repeated.flac', playable: true },
    { path: '/music/missing.flac', playable: false },
    { path: '/music/repeated.flac', playable: true }
  ]

  assert.deepEqual(
    buildPlayableOccurrenceIndexes(occurrences, (occurrence) => occurrence.playable),
    [0, null, 1]
  )
})
