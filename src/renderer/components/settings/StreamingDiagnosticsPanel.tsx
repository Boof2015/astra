import { useEffect, useState } from 'react'
import { audioEngine } from '../../audio/AudioEngine'
import { usePlayerStore } from '../../stores/playerStore'
import { pollStreamingDiagnostics, type StreamingDiagnosticsReading } from '../../utils/streamingDiagnostics'
import StreamingDiagnosticsView from './StreamingDiagnosticsView'

async function readDiagnostics(): Promise<StreamingDiagnosticsReading | null> {
  const clock = audioEngine.getStreamingDiagnosticsState()
  const track = usePlayerStore.getState().currentTrack
  if (!track || track.path !== clock.path) return null
  const ids = [clock.sessionId, clock.nextSessionId].filter((id): id is number => id !== null && id > 0)
  const sessions = ids.length ? await window.electronAPI.getStreamingDiagnostics(ids) : []
  const after = audioEngine.getStreamingDiagnosticsState()
  if (after.path !== clock.path || after.sessionId !== clock.sessionId || after.nextSessionId !== clock.nextSessionId) return null
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

function LiveStreamingDiagnostics() {
  const [reading, setReading] = useState<StreamingDiagnosticsReading | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => pollStreamingDiagnostics({
    read: readDiagnostics,
    deliver: value => { setReading(value); setFailed(false) },
    failed: () => { setReading(null); setFailed(true) },
    visible: () => document.visibilityState !== 'hidden',
    subscribeVisibility: changed => {
      document.addEventListener('visibilitychange', changed)
      return () => document.removeEventListener('visibilitychange', changed)
    }
  }), [])
  if (failed) return <p role="status">Couldn’t read streaming diagnostics. Retrying…</p>
  if (!reading) return <p>Play a track to see its stream.</p>
  return <StreamingDiagnosticsView reading={reading} />
}

export default function StreamingDiagnosticsPanel() {
  const [open, setOpen] = useState(false)
  return <div className="settings-info-panel streaming-diagnostics">
    <div className="streaming-diagnostics-heading">
      <h4>Streaming diagnostics</h4>
      <button type="button" className="settings-btn" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {open ? 'Close live view' : 'Open live view'}
      </button>
    </div>
    {open ? <LiveStreamingDiagnostics /> : <p>Playback, buffering and Stratum segment activity.</p>}
  </div>
}
