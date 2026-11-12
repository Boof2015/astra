import { useCallback, useSyncExternalStore } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { usePlayerStore } from '../stores/playerStore'
import { createStreamingDiagnosticsFeed, type StreamingDiagnosticsReading, type StreamingDiagnosticsSnapshot } from '../utils/streamingDiagnostics'

async function readStreamingDiagnostics(): Promise<StreamingDiagnosticsReading | null> {
  const clock = audioEngine.getStreamingDiagnosticsState()
  const track = usePlayerStore.getState().currentTrack
  if (!track || track.path !== clock.path) return null
  const ids = [clock.sessionId, clock.nextSessionId].filter((id): id is number => id !== null && id > 0)
  const sessions = ids.length ? await window.electronAPI.getStreamingDiagnostics(ids) : []
  const after = audioEngine.getStreamingDiagnosticsState()
  if (usePlayerStore.getState().currentTrack?.path !== track.path || after.path !== clock.path || after.sessionId !== clock.sessionId || after.nextSessionId !== clock.nextSessionId) return null
  const session = sessions.find(item => item.sessionId === clock.sessionId) ?? null
  const next = sessions.find(item => item.sessionId === clock.nextSessionId) ?? null
  const progress = usePlayerStore.getState().remoteLoadProgress
  const matching = progress?.path === track.path && progress.sessionId === clock.sessionId ? progress : null
  const transport = session?.transport ?? clock.transport ?? (track.sourceType && track.sourceType !== 'local' ? 'stream' : 'local')
  return {
    trackKey: track.path,
    title: track.title, artist: track.artist, position: after.position, duration: after.duration,
    playbackState: after.state, start: after.start, bufferedEnd: after.bufferedEnd,
    completeLocalBuffer: transport === 'local' && after.completeLocalBuffer, transport,
    quality: after.quality, session, next,
    loadedBytes: session?.loadedBytes ?? matching?.loadedBytes ?? null,
    totalBytes: session?.totalBytes ?? matching?.totalBytes ?? null
  }
}

const feed = createStreamingDiagnosticsFeed({
  read: readStreamingDiagnostics,
  visible: () => document.visibilityState !== 'hidden',
  subscribeVisibility: changed => {
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }
})
const empty: StreamingDiagnosticsSnapshot<StreamingDiagnosticsReading> = { reading: null, failed: false }

export function useStreamingDiagnostics(enabled = true) {
  const subscribe = useCallback((changed: () => void) => enabled ? feed.subscribe(changed) : () => {}, [enabled])
  const state = useSyncExternalStore(subscribe, feed.getSnapshot, () => empty)
  return enabled ? state : empty
}
