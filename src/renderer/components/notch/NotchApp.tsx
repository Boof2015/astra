import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { EMPTY_NOTCH_STATE, NOTCH_SIZE } from '../../../types/notch'
import { mergeMiniPlayerSnapshots, type MiniPlayerSnapshot } from '../../../types/miniPlayer'
import NotchScope from './NotchScope'
import { useNotchSeek } from './useNotchSeek'
import { notchContourBounds, notchPeekContour, tweenNotchContour, type NotchContour } from '../../../shared/notchContour'
import '../../styles/notch.css'

function Icon({ name }: { name: 'previous' | 'next' | 'play' | 'pause' | 'collapse' | 'open' | 'volume' | 'muted' | 'music' }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'play' && <path d="M7 4.5v15L20 12Z" fill="currentColor" strokeWidth="1.2" />}
    {name === 'pause' && <g fill="currentColor" stroke="none"><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></g>}
    {name === 'previous' && <path d="m11 5-9 7 9 7V5Zm11 0-9 7 9 7V5Z" fill="currentColor" strokeWidth="1.2" />}
    {name === 'next' && <path d="m2 5 9 7-9 7V5Zm11 0 9 7-9 7V5Z" fill="currentColor" strokeWidth="1.2" />}
    {name === 'collapse' && <path d="m7 14 5-5 5 5" />}
    {name === 'open' && <path d="M6 18 18 6M7 6h11v11" />}
    {(name === 'volume' || name === 'muted') && <><path d="m11 5-5 4H3v6h3l5 4Z" />{name === 'volume' ? <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /> : <path d="m16 9 5 6m0-6-5 6" />}</>}
    {name === 'music' && <><path d="M9 18V5l11-2v13M9 8l11-2" /><ellipse cx="6" cy="18" rx="3" ry="2.5" /><ellipse cx="17" cy="16" rx="3" ry="2.5" /></>}
  </svg>
}
function time(value: number): string {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
function rangeFill(value: number, maximum: number): CSSProperties {
  return { '--notch-fill': `${maximum > 0 ? Math.max(0, Math.min(100, value / maximum * 100)) : 0}%` } as CSSProperties
}

export default function NotchApp() {
  const [state, setState] = useState(EMPTY_NOTCH_STATE)
  const [snapshot, setSnapshot] = useState<MiniPlayerSnapshot | null>(null)
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [volume, setVolume] = useState<number | null>(null)
  const [badArtwork, setBadArtwork] = useState<string | null>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const contourRef = useRef<NotchContour | null>(null)
  const opacityRef = useRef(0)
  const playerOpacityRef = useRef(0)
  const playerRef = useRef<HTMLElement>(null)
  const keyboardExpansionRef = useRef(false)
  const playRef = useRef<HTMLButtonElement>(null)
  const openRef = useRef<HTMLButtonElement>(null)
  const api = window.electronAPI.notch
  const view = state.view
  const expanded = view === 'expanded'
  const { progress, input: seekInput } = useNotchSeek(snapshot, expanded, time => api.sendCommand({ type: 'seek', time }))
  const peeking = view === 'peek'
  const notchWidth = state.notchWidth ?? 0
  const notchHeight = state.notchHeight ?? 0
  const previewWidth = state.reason === 'resting' && view !== 'hidden' ? notchWidth : Math.min(NOTCH_SIZE.width, notchWidth + 64)
  const visible = view !== 'hidden' && notchWidth > 0
  const scope = view === 'oscilloscope' || view === 'spectrum' ? view : null
  const restingScope = state.prefs.restingView === 'oscilloscope' || state.prefs.restingView === 'spectrum' ? state.prefs.restingView : null
  const track = snapshot?.currentTrack
  const artwork = track?.artworkData
  const color = snapshot?.visualizerLineColor || '#38bdf8'
  const playing = snapshot?.playbackState === 'playing'
  const height = notchHeight + (expanded ? NOTCH_SIZE.height : NOTCH_SIZE.previewHeight)
  const width = expanded ? NOTCH_SIZE.width : previewWidth
  const peekProximity = reduced ? 0.5 : state.proximity

  useEffect(() => {
    let active = true
    const receive = (next: MiniPlayerSnapshot) => setSnapshot(current => mergeMiniPlayerSnapshots(current, next))
    const unsubscribeState = api.onState(setState)
    const unsubscribeSnapshot = api.onSnapshot(receive)
    void api.getState().then(next => { if (active) setState(next) })
    void api.getSnapshot().then(next => { if (active && next) receive(next) })
    api.ready()
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => { setReduced(media.matches); api.setReducedMotion(media.matches) }
    sync(); media.addEventListener('change', sync)
    return () => { active = false; unsubscribeState(); unsubscribeSnapshot(); media.removeEventListener('change', sync) }
  }, [api])

  useLayoutEffect(() => {
    const surface = surfaceRef.current!
    if (notchWidth <= 0 || notchHeight <= 0) return
    const concealed = { topWidth: notchWidth - 2, bottomWidth: notchWidth - 2, height: notchHeight - 1 }
    const from = contourRef.current ?? concealed
    const target = !visible ? concealed : peeking
      ? notchPeekContour(notchWidth, notchHeight, peekProximity)
      : { topWidth: width, bottomWidth: width, height }
    const opening = target.topWidth > from.topWidth || target.height > from.height
    const duration = reduced || peeking ? 90 : opening ? 280 : 220
    const fromOpacity = opacityRef.current
    const fromPlayerOpacity = playerOpacityRef.current
    let frame = 0
    const start = performance.now()
    const report = () => {
      const progress = Math.min(1, (performance.now() - start) / duration)
      const contour = reduced ? visible ? target : from : tweenNotchContour(from, target, progress)
      const finished = progress === 1
      const opacity = reduced ? fromOpacity + ((visible ? 1 : 0) - fromOpacity) * progress : !visible && finished ? 0 : 1
      // Keep the full-size player painted as the contour retracts across it.
      // Only hand off to the preview in the last strip-height of travel;
      // deriving this from geometry also preserves it when motion reverses.
      const handoff = Math.max(0, Math.min(1, (contour.height - notchHeight - NOTCH_SIZE.previewHeight) / NOTCH_SIZE.previewHeight))
      const playerOpacity = reduced
        ? fromPlayerOpacity + ((expanded ? 1 : 0) - fromPlayerOpacity) * progress
        : handoff * handoff * (3 - 2 * handoff)
      contourRef.current = contour
      opacityRef.current = opacity
      playerOpacityRef.current = playerOpacity
      const bounds = notchContourBounds(contour, NOTCH_SIZE.width)
      surface.style.clipPath = `polygon(${bounds.points.map(point => `${point.x}px ${point.y}px`).join(',')})`
      surface.style.opacity = String(opacity)
      surface.style.setProperty('--notch-top-width', String(contour.topWidth))
      surface.style.setProperty('--notch-bottom-width', String(contour.bottomWidth))
      surface.style.setProperty('--notch-surface-height', String(contour.height))
      surface.style.setProperty('--notch-player-opacity', String(playerOpacity))
      surface.style.setProperty('--notch-content-opacity', String((1 - playerOpacity) * Math.max(0, Math.min(1, (contour.height - notchHeight - 7) / 16))))
      api.setSurface(opacity > 0.01 ? bounds : { x: 0, y: 0, width: 0, height: 0, points: [] })
      if (!finished) frame = requestAnimationFrame(report)
      else if (!visible) contourRef.current = concealed
    }
    report()
    return () => cancelAnimationFrame(frame)
  }, [api, height, width, visible, reduced, notchWidth, notchHeight, peeking, peekProximity, expanded])

  useEffect(() => {
    setVolume(null)
  }, [expanded, track?.path])
  useEffect(() => {
    if (!expanded) return
    // A pointer-opened panel focuses its container, leaving controls visually
    // quiet until keyboard navigation. Keyboard/AX activation goes to Play.
    const target = keyboardExpansionRef.current
      ? playRef.current?.disabled ? openRef.current : playRef.current
      : playerRef.current
    target?.focus({ preventScroll: true })
    keyboardExpansionRef.current = false
  }, [expanded])

  const metadata = <div className="notch-meta"><div className="notch-title">{track?.title || 'Nothing playing'}</div><div className="notch-artist">{track?.artist || 'Open Astra to choose your music'}</div></div>
  const art = artwork && badArtwork !== artwork
    ? <img src={artwork} alt="" onError={() => setBadArtwork(artwork)} />
    : <span className="notch-art-placeholder" aria-hidden="true"><Icon name="music" /></span>
  const duration = snapshot?.duration ?? 0
  const effectiveVolume = volume ?? (snapshot?.isMuted ? 0 : snapshot?.volume ?? 1)
  const muted = Boolean(snapshot?.isMuted)

  return <div className="notch-root" style={{ '--notch-accent': color, '--notch-height': `${notchHeight}px`, '--notch-player-height': `${NOTCH_SIZE.height}px`, '--notch-backing-height': `${NOTCH_SIZE.backingHeight}px`, '--notch-preview-width': `${previewWidth}px`, '--notch-preview-height': `${NOTCH_SIZE.previewHeight}px` } as CSSProperties}>
    <div ref={surfaceRef} className={`notch-surface ${expanded ? 'is-expanded' : ''} ${visible ? 'is-visible' : ''} ${reduced ? 'reduce-motion' : ''}`}>
      <button className={`notch-preview ${!expanded && visible ? peeking ? 'is-peeking' : 'is-shown' : ''}`} tabIndex={expanded || peeking || !visible ? -1 : 0}
        aria-hidden={expanded || peeking || !visible} aria-label={track ? `Expand player: ${track.title}, ${track.artist}` : 'Expand Astra player'} onClick={event => { keyboardExpansionRef.current = event.detail === 0; api.expand() }}>
        <div className={`notch-preview-metadata ${scope || peeking ? '' : 'is-shown'}`}>
          <span className="notch-preview-title">{track?.title || (track ? 'Untitled' : 'Nothing playing')}</span>
          {track?.artist && <><span className="notch-preview-separator" aria-hidden="true">·</span><span className="notch-preview-artist">{track.artist}</span></>}
        </div>
        <div className={`notch-preview-scope ${scope ? 'is-shown' : ''}`}>
          {restingScope && <NotchScope width={Math.max(0, previewWidth - 24)} height={NOTCH_SIZE.previewHeight - 4} mode={restingScope} active={Boolean(scope && playing && !reduced)} frozen={!scope} color={color} />}
        </div>
      </button>
      <section ref={playerRef} tabIndex={-1} className="notch-player" inert={!expanded} aria-label="Astra notch player" aria-hidden={!expanded}>
        <div className="notch-track"><div className="notch-art">{art}</div><div className="notch-track-detail">{metadata}
          <div className="notch-transport">
            <button aria-label="Previous track" disabled={!track} onClick={() => api.sendCommand({ type: 'playPrevious' })}><Icon name="previous" /></button>
            <button ref={playRef} className="notch-play" aria-label={playing ? 'Pause' : 'Play'} disabled={!track} onClick={() => api.sendCommand({ type: 'togglePlay' })}><Icon name={playing ? 'pause' : 'play'} /></button>
            <button aria-label="Next track" disabled={!track} onClick={() => api.sendCommand({ type: 'playNext' })}><Icon name="next" /></button>
          </div>
          <div className="notch-seek"><input type="range" aria-label="Seek" aria-valuetext={`${time(progress)} of ${time(duration)}`} min="0" max={Math.max(1, duration)} step="0.1" value={progress} style={rangeFill(progress, duration)} disabled={!track || duration <= 0}
          {...seekInput} />
            <div className="notch-times"><span>{time(progress)}</span><span>−{time(duration - progress)}</span></div>
          </div>
        </div></div>
        <footer><div className="notch-volume"><button aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'} onClick={() => api.sendCommand({ type: 'toggleMute' })}><Icon name={effectiveVolume <= 0 ? 'muted' : 'volume'} /></button><input type="range" aria-label="Volume" aria-valuetext={`${Math.round(effectiveVolume * 100)}%`} min="0" max="1" step="0.01" value={effectiveVolume} style={rangeFill(effectiveVolume, 1)}
          onChange={event => { const next = Number(event.target.value); setVolume(next); api.sendCommand({ type: 'setVolume', volume: next }) }} onPointerUp={() => setVolume(null)} onBlur={() => setVolume(null)} onKeyUp={() => setVolume(null)} /></div>
          <button ref={openRef} className="notch-open" onClick={() => api.openAstra()}>Open Astra<Icon name="open" /></button></footer>
        <button className="notch-collapse" title="Collapse player" aria-label="Collapse player" onClick={() => api.collapse()}><Icon name="collapse" /></button>
      </section>
    </div>
  </div>
}
