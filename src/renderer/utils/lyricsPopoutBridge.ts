import type {
  LyricsPopoutSnapshot,
  LyricsPopoutTrackSnapshot
} from '../../types/lyricsPopout'
import type { LyricsTrackQuery } from '../../types/lyrics'

export const LYRICS_POPOUT_RESYNC_INTERVAL_MS = 1000
export const LYRICS_POPOUT_TIME_JUMP_THRESHOLD_SECONDS = 0.2

export type LyricsPopoutPublishTrigger = 'state-change' | 'resync-tick'

export type LyricsPopoutPublishReason =
  | 'closed'
  | 'window-opened'
  | 'no-snapshot'
  | 'semantic-change'
  | 'time-jump'
  | 'resync'
  | 'not-needed'

export interface EvaluateLyricsPopoutPublishOptions {
  trigger: LyricsPopoutPublishTrigger
  isWindowOpen: boolean
  wasWindowOpen: boolean
  nextSnapshot: LyricsPopoutSnapshot
  lastPublishedSnapshot: LyricsPopoutSnapshot | null
  now?: number
  resyncIntervalMs?: number
  timeJumpThresholdSeconds?: number
}

function areTrackSnapshotsEqual(
  left: LyricsPopoutTrackSnapshot | null,
  right: LyricsPopoutTrackSnapshot | null
): boolean {
  if (left === right) return true
  if (!left || !right) return false

  return left.path === right.path &&
    left.title === right.title &&
    left.artist === right.artist &&
    left.album === right.album
}

function areLyricsQueriesEqual(
  left: LyricsTrackQuery | null,
  right: LyricsTrackQuery | null
): boolean {
  if (left === right) return true
  if (!left || !right) return false

  return left.path === right.path &&
    left.title === right.title &&
    left.artist === right.artist &&
    left.album === right.album &&
    left.durationSeconds === right.durationSeconds
}

function hasSemanticSnapshotChange(
  previous: LyricsPopoutSnapshot,
  next: LyricsPopoutSnapshot
): boolean {
  return previous.playbackState !== next.playbackState ||
    previous.duration !== next.duration ||
    previous.effectiveDelayMs !== next.effectiveDelayMs ||
    previous.preferredExpanded !== next.preferredExpanded ||
    previous.isLoading !== next.isLoading ||
    previous.errorMessage !== next.errorMessage ||
    !areTrackSnapshotsEqual(previous.currentTrack, next.currentTrack) ||
    !areLyricsQueriesEqual(previous.lyricsQuery, next.lyricsQuery) ||
    previous.lyricsResult !== next.lyricsResult
}

function getExpectedPlaybackTime(
  snapshot: LyricsPopoutSnapshot,
  now: number
): number {
  if (snapshot.playbackState !== 'playing') {
    return snapshot.currentTime
  }

  const elapsedSeconds = Math.max(0, (now - snapshot.capturedAt) / 1000)
  const projectedTime = snapshot.currentTime + elapsedSeconds
  if (!Number.isFinite(snapshot.duration) || snapshot.duration <= 0) {
    return Math.max(0, projectedTime)
  }

  return Math.max(0, Math.min(snapshot.duration, projectedTime))
}

export function getLyricsPopoutPublishReason({
  trigger,
  isWindowOpen,
  wasWindowOpen,
  nextSnapshot,
  lastPublishedSnapshot,
  now = nextSnapshot.capturedAt,
  resyncIntervalMs = LYRICS_POPOUT_RESYNC_INTERVAL_MS,
  timeJumpThresholdSeconds = LYRICS_POPOUT_TIME_JUMP_THRESHOLD_SECONDS
}: EvaluateLyricsPopoutPublishOptions): LyricsPopoutPublishReason {
  if (!isWindowOpen) {
    return 'closed'
  }

  if (!wasWindowOpen) {
    return 'window-opened'
  }

  if (!lastPublishedSnapshot) {
    return 'no-snapshot'
  }

  if (hasSemanticSnapshotChange(lastPublishedSnapshot, nextSnapshot)) {
    return 'semantic-change'
  }

  if (trigger === 'resync-tick') {
    if (
      nextSnapshot.playbackState === 'playing' &&
      (now - lastPublishedSnapshot.capturedAt) >= resyncIntervalMs
    ) {
      return 'resync'
    }
    return 'not-needed'
  }

  const expectedTime = getExpectedPlaybackTime(lastPublishedSnapshot, now)
  if (Math.abs(nextSnapshot.currentTime - expectedTime) >= timeJumpThresholdSeconds) {
    return 'time-jump'
  }

  return 'not-needed'
}
