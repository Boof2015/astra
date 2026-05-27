import { useParallaxStore } from '../../stores/parallaxStore'

export default function ParallaxSinkMode() {
  const status = useParallaxStore((s) => s.status)
  const disconnectSink = useParallaxStore((s) => s.disconnectSink)
  const errorMessage = useParallaxStore((s) => s.errorMessage)

  if (!status?.sink.connected) return null

  const stream = status.sink.activeStream
  const clockLabel = status.sink.rttMs !== null
    ? `${Math.round(status.sink.rttMs)} ms RTT`
    : 'Clock syncing'

  return (
    <div className="parallax-sink-mode" role="status" aria-live="polite">
      <div className="parallax-sink-copy">
        <span className="parallax-sink-kicker">Parallax Sink</span>
        <span className="parallax-sink-title">
          {stream ? `${stream.title} - ${stream.artist}` : 'Waiting for host playback'}
        </span>
        <span className="parallax-sink-meta">{status.sink.baseUrl} · {clockLabel}</span>
        {errorMessage && <span className="parallax-sink-error">{errorMessage}</span>}
      </div>
      <button
        type="button"
        className="settings-btn settings-btn-danger"
        onClick={() => void disconnectSink()}
      >
        Disconnect
      </button>
    </div>
  )
}
