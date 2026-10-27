import { useState } from 'react'
import { useStreamingDiagnostics } from '../../hooks/useStreamingDiagnostics'
import StreamingDiagnosticsView from './StreamingDiagnosticsView'

function LiveStreamingDiagnostics() {
  const { reading, failed } = useStreamingDiagnostics()
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
