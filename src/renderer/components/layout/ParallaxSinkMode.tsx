import LocalizedText from '../i18n/LocalizedText'
import { translate } from '../../i18n'
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
        <span className="parallax-sink-kicker"><LocalizedText ns="common" i18nKey="auto.parallaxsinkmode.parallax_sink" /></span>
        <span className="parallax-sink-title">
          {!playbackEnabled
            ? translate('common:auto.parallaxsinkmode.connected_not_selected_for_playback')
            : stream ? translate('common:auto.parallaxsinkmode.title_artist', { title: stream.title, artist: stream.artist }) : translate('common:auto.parallaxsinkmode.waiting_for_host_playback')}
        </span>
        <span className="parallax-sink-meta">{status.sink.baseUrl} · {clockLabel} · {bufferLabel}</span>
        {errorMessage && <span className="parallax-sink-error">{errorMessage}</span>}
      </div>
      <div className="parallax-sink-actions">
        <button
          type="button"
          className="settings-btn"
          onClick={enterZoneDisplay}
          title={translate('common:auto.parallaxsinkmode.open_zone_display')}
        >

          <LocalizedText ns="common" i18nKey="auto.parallaxsinkmode.zone_display" />
        </button>
        <button
          type="button"
          className="settings-btn settings-btn-danger"
          onClick={() => void disconnectSink()}
        >

          <LocalizedText ns="common" i18nKey="auto.parallaxsinkmode.disconnect" />
        </button>
      </div>
    </div>
  )
}
