import { useParallaxStore } from '../../stores/parallaxStore'
import { useUIStore } from '../../stores/uiStore'

export default function ParallaxSinkMode() {
  const status = useParallaxStore((s) => s.status)
  const snapshot = useParallaxStore((s) => s.sinkSnapshot)
  const disconnectSink = useParallaxStore((s) => s.disconnectSink)
  const errorMessage = useParallaxStore((s) => s.errorMessage)
  const enterZoneDisplay = useUIStore((s) => s.enterZoneDisplay)

  if (!status?.sink.connected) return null

  const stream = status.sink.activeStream
  const playbackEnabled = status.sink.playbackEnabled !== false
  const clockLabel = status.sink.rttMs !== null
    ? `${Math.round(status.sink.rttMs)} ms RTT`
    : 'Clock syncing'
  const bufferLabel = stream && snapshot.streamId === stream.streamId
    ? `Buffer ${Math.round((snapshot.bufferedFrames / stream.sampleRate) * 1000)} ms · Underruns ${snapshot.underruns}`
    : 'Buffer waiting'

  return (
    <div className="parallax-sink-mode" role="status" aria-live="polite">
      <div className="parallax-sink-copy">
        <span className="parallax-sink-kicker">Parallax Sink</span>
        <span className="parallax-sink-title">
          {!playbackEnabled
            ? 'Connected, not selected for playback'
            : stream ? `${stream.title} - ${stream.artist}` : 'Waiting for host playback'}
        </span>
        <span className="parallax-sink-meta">{status.sink.baseUrl} · {clockLabel} · {bufferLabel}</span>
        {errorMessage && <span className="parallax-sink-error">{errorMessage}</span>}
      </div>
      <div className="parallax-sink-actions">
        <button
          type="button"
          className="settings-btn"
          onClick={enterZoneDisplay}
          title="Open Zone Display"
        >
          Zone Display
        </button>
        <button
          type="button"
          className="settings-btn settings-btn-danger"
          onClick={() => void disconnectSink()}
        >
          Disconnect
        </button>
      </div>
    </div>
  )
}
