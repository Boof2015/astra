import type { PlaybackState } from '../types/audio'
import type { ParallaxStatus } from '../../types/parallax'

export type AstraActivityState =
  | 'idle'
  | 'playing'
  | 'paused'
  | 'loading-track'
  | 'library-scan'
  | 'remote-streaming'
  | 'remote-sync'
  | 'integrity-scan'
  | 'lyrics-lookup'
  | 'parallax-connected'

export type AstraActivityEvent =
  | 'metadata-saving'
  | 'external-connected'
  | 'attention'

export interface AstraActivityInputs {
  playbackState: PlaybackState
  isIntegrityScanning?: boolean
  isLibraryScanning?: boolean
  isRemoteSyncing?: boolean
  isRemoteStreaming?: boolean
  isInternetLookup?: boolean
  isLyricsLookup?: boolean
  isParallaxConnected?: boolean
}

export interface AstraActivityEventFlags {
  metadataSaving: boolean
  externalConnected: boolean
  attention: boolean
}

export const ASTRA_ACTIVITY_STATE_ORDER: readonly AstraActivityState[] = [
  'idle',
  'playing',
  'paused',
  'loading-track',
  'library-scan',
  'remote-streaming',
  'remote-sync',
  'integrity-scan',
  'lyrics-lookup',
  'parallax-connected',
]

export const ASTRA_ACTIVITY_STATE_NOTES: Record<AstraActivityState, string> = {
  idle: 'No background activity',
  playing: 'Audio playback active',
  paused: 'Playback held',
  'loading-track': 'Fetching or decoding next file',
  'library-scan': 'Indexing local files',
  'remote-streaming': 'Buffering remote audio',
  'remote-sync': 'Subsonic / Jellyfin sync',
  'integrity-scan': 'Verifying library integrity',
  'lyrics-lookup': 'Internet lookup active',
  'parallax-connected': 'Parallax connection active',
}

export const ASTRA_ACTIVITY_EVENT_DURATIONS_MS: Record<AstraActivityEvent, number> = {
  'metadata-saving': 1000,
  'external-connected': 720,
  attention: 720,
}

export function isParallaxConnectionActive(status: ParallaxStatus | null | undefined): boolean {
  if (!status) return false

  const hostHasOnlineSink = status.host.connectedSinks.some((sink) => sink.online)
  const sinkHasReachableHost = status.sink.connected && status.sink.hostReachable !== false
  return hostHasOnlineSink || sinkHasReachableHost
}

export function resolveAstraActivityState(input: AstraActivityInputs): AstraActivityState {
  if (input.isIntegrityScanning) return 'integrity-scan'
  if (input.isLibraryScanning) return 'library-scan'
  if (input.isRemoteSyncing) return 'remote-sync'
  if (input.playbackState === 'loading') return 'loading-track'
  if (input.isRemoteStreaming) return 'remote-streaming'
  if (input.isInternetLookup || input.isLyricsLookup) return 'lyrics-lookup'
  if (input.isParallaxConnected) return 'parallax-connected'
  if (input.playbackState === 'playing') return 'playing'
  if (input.playbackState === 'paused') return 'paused'
  return 'idle'
}

export function resolveAstraActivityEvent(
  current: AstraActivityEventFlags,
  previous: AstraActivityEventFlags
): AstraActivityEvent | null {
  if (current.attention && !previous.attention) return 'attention'
  if (current.metadataSaving && !previous.metadataSaving) return 'metadata-saving'
  if (current.externalConnected && !previous.externalConnected) return 'external-connected'
  return null
}
