import { useEffect, useRef, useState } from 'react'
import { STREAMING_BITRATES, streamingQualitySourceKey, streamingQualityLabel, isStreamingQuality, type StreamingQuality, type StreamingQualitySettings as Settings,
  type StreamingQualitySource } from '../../../types/streamingQuality'

export default function StreamingQualitySettings({ source }: { source?: StreamingQualitySource }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const eventGeneration = useRef(0)
  const sourceKey = source ? streamingQualitySourceKey(source) : null
  useEffect(() => {
    let active = true
    let receivedEvent = false
    const unsubscribe = window.electronAPI.onStreamingQualityChanged(value => {
      eventGeneration.current++
      receivedEvent = true
      if (active) setSettings(value)
    })
    void window.electronAPI.getStreamingQuality().then(value => {
      if (active && !receivedEvent) setSettings(value)
    }).catch(() => { if (active) setError('Could not read streaming quality.') })
    return () => { active = false; unsubscribe() }
  }, [])

  const update = async (value: string) => {
    const quality: StreamingQuality | null = value === 'global' ? null : isStreamingQuality(value) ? value : Number(value) as StreamingQuality
    setBusy(true)
    setError(null)
    const generation = eventGeneration.current
    try {
      const value = await window.electronAPI.setStreamingQuality(quality, source)
      // Broadcasts can already contain a later edit from another control/window.
      if (eventGeneration.current === generation) setSettings(value)
    }
    catch { setError('Could not save streaming quality. Please try again.') }
    finally { setBusy(false) }
  }
  const selector = <>
    <label className="settings-field">
      <span className="settings-field-label">Streaming quality</span>
      <select className="settings-select" disabled={!settings || busy}
        value={sourceKey ? settings?.overrides[sourceKey] ?? 'global' : settings?.global ?? 'original'}
        onChange={event => { void update(event.target.value) }}>
        {sourceKey && <option value="global">Use global setting ({streamingQualityLabel(settings?.global ?? 'original')})</option>}
        <option value="automatic">Automatic</option>
        <option value="automatic-original">Automatic (prioritize original)</option>
        <option value="original">Original{!sourceKey ? ' (default)' : ''}</option>
        {STREAMING_BITRATES.map(bitrate => <option key={bitrate} value={bitrate}>{bitrate} kbps</option>)}
      </select>
    </label>
    {error && <p className="settings-note settings-note-error" role="alert">{error}</p>}
  </>
  if (source) return <div>{selector}<p className="settings-note">Changes apply to the next track.</p></div>
  return <section className="settings-card">
    <h4 className="settings-card-label">Streaming quality</h4>
    {selector}
    <p className="settings-note">Automatic adapts to sustained connection speed and buffer headroom. Prioritize original holds onto original quality longer. Original preserves the server file. Bitrate presets request a smaller stream when the server supports conversion. Actual audio details appear in the audio pipeline.</p>
    <p className="settings-note">Applies to Subsonic, Navidrome and Jellyfin unless a server overrides it. Changes apply to the next track.</p>
  </section>
}
