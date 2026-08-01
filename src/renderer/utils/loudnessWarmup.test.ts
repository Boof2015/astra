import test from 'node:test'
import assert from 'node:assert/strict'
import { selectUpcomingLoudnessWarmupTracks } from './loudnessWarmup.ts'

interface Candidate {
  path: string
  sourceType?: string
  isAvailable?: boolean
  hasReplayGain?: boolean
}

const needsAnalysis = (track: Candidate) => !track.hasReplayGain

test('loudness warmup selects no work without an upcoming track', () => {
  assert.deepEqual(selectUpcomingLoudnessWarmupTracks([], needsAnalysis), [])
})

test('loudness warmup selects the sole upcoming track in a two-track queue', () => {
  const upcoming: Candidate[] = [{ path: '/music/next.flac' }]
  assert.deepEqual(selectUpcomingLoudnessWarmupTracks(upcoming, needsAnalysis), upcoming)
})

test('loudness warmup selects only the first eligible upcoming local track', () => {
  const candidates: Candidate[] = [
    { path: '/music/a.flac' },
    { path: '/music/b.flac' },
    { path: '/music/c.flac' }
  ]
  assert.deepEqual(
    selectUpcomingLoudnessWarmupTracks(candidates, needsAnalysis).map((track) => track.path),
    ['/music/a.flac']
  )
})

test('loudness warmup skips duplicates, remote or unavailable tracks, and ReplayGain hits', () => {
  const candidates: Candidate[] = [
    { path: 'subsonic://remote', sourceType: 'subsonic' },
    { path: '/music/missing.flac', isAvailable: false },
    { path: '/music/gained.flac', hasReplayGain: true },
    { path: '/music/next.flac' },
    { path: '/music/next.flac' },
    { path: '/music/later.flac' }
  ]
  assert.deepEqual(
    selectUpcomingLoudnessWarmupTracks(candidates, needsAnalysis).map((track) => track.path),
    ['/music/next.flac']
  )
})

test('loudness warmup preserves the queue order supplied by repeat or shuffle resolution', () => {
  const shuffledCandidates: Candidate[] = [
    { path: '/music/shuffled-first.flac' },
    { path: '/music/original-first.flac' }
  ]
  assert.equal(selectUpcomingLoudnessWarmupTracks(shuffledCandidates, needsAnalysis)[0]?.path, '/music/shuffled-first.flac')
})
