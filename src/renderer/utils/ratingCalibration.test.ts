import assert from 'node:assert/strict'
import test from 'node:test'
import { selectRatingNeighbors } from './ratingCalibration.ts'

function ratingsMap(entries: Array<[string, number, number]>): Map<string, { rating: number; updatedAt: number }> {
  return new Map(entries.map(([trackPath, rating, updatedAt]) => [trackPath, { rating, updatedAt }]))
}

test('selectRatingNeighbors picks nearest per side with equal ratings counting as above', () => {
  const ratings = ratingsMap([
    ['five', 5, 1],
    ['four', 4, 1],
    ['exact', 3.5, 1],
    ['three', 3, 1],
    ['one', 1, 1]
  ])

  const selection = selectRatingNeighbors(3.5, ratings, new Set())
  assert.deepEqual(selection.above.map((neighbor) => neighbor.trackPath), ['exact', 'four'])
  assert.deepEqual(selection.below.map((neighbor) => neighbor.trackPath), ['three', 'one'])
})

test('selectRatingNeighbors breaks distance ties by most recent update, then path', () => {
  const ratings = ratingsMap([
    ['older', 4, 10],
    ['newer', 4, 20],
    ['aaa-same-time', 4, 20]
  ])

  const selection = selectRatingNeighbors(3.5, ratings, new Set())
  assert.deepEqual(selection.above.map((neighbor) => neighbor.trackPath), ['aaa-same-time', 'newer'])
})

test('selectRatingNeighbors excludes the tracks being rated and handles one-sided results', () => {
  const ratings = ratingsMap([
    ['self', 4, 1],
    ['other', 4.5, 1]
  ])

  const selection = selectRatingNeighbors(4, ratings, new Set(['self']))
  assert.deepEqual(selection.above.map((neighbor) => neighbor.trackPath), ['other'])
  assert.deepEqual(selection.below, [])
})

test('selectRatingNeighbors returns empty groups when nothing else is rated', () => {
  const selection = selectRatingNeighbors(3, new Map(), new Set())
  assert.deepEqual(selection, { above: [], below: [] })
})
