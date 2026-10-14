import { useEffect, useRef, useState } from 'react'
import {
  streamingQualitySourceKey, type StreamingQuality, type StreamingQualitySettings, type StreamingQualitySource
} from '../../../../types/streamingQuality'
import SettingsSegmentedControl from '../SettingsSegmentedControl'
import {
  DEFAULT_FIXED_BITRATE, QUALITY_BITRATES, qualityCopy, qualityFollowUps, qualityFromChoice, qualityMode,
  type AutomaticPriority, type QualityBitrate, type QualityMode
} from './serverModel'
import type { ServerEntry } from './useServers'

/** Global quality plus per-server overrides, kept current across every control and window. */
function useStreamingQualitySettings() {
  const [settings, setSettings] = useState<StreamingQualitySettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const eventGeneration = useRef(0)
  useEffect(() => {
    let active = true
    let receivedEvent = false
    const unsubscribe = window.electronAPI.onStreamingQualityChanged(value => {
      eventGeneration.current++
      receivedEvent = true
      if (active) setSettings(value)
    })
    void window.electronAPI.getStreamingQuality()
      .then(value => { if (active && !receivedEvent) setSettings(value) })
      .catch(() => { if (active) setError('Could not read streaming quality.') })
    return () => { active = false; unsubscribe() }
  }, [])
  const save = async (quality: StreamingQuality | null, source?: StreamingQualitySource) => {
    setError(null)
    const generation = eventGeneration.current
    try {
      const value = await window.electronAPI.setStreamingQuality(quality, source)
      // A broadcast may already carry a later edit from another control or window.
      if (eventGeneration.current === generation) setSettings(value)
      return true
    } catch {
      setError('Could not save streaming quality. Please try again.')
      return false
    }
  }
  return { settings, error, save }
}

type Choice = QualityMode | 'default'

const MODE_OPTIONS = [
  { value: 'automatic', label: 'Automatic' },
  { value: 'original', label: 'Original' },
  { value: 'fixed', label: 'Fixed' }
] as const satisfies readonly { value: Choice; label: string }[]
const SERVER_OPTIONS = [{ value: 'default', label: 'Use default' } as const, ...MODE_OPTIONS]
const PRIORITY_OPTIONS = [
  { value: 'balanced', label: 'Balanced' },
  { value: 'original', label: 'Prefer original' }
] as const satisfies readonly { value: AutomaticPriority; label: string }[]
const BITRATE_OPTIONS = QUALITY_BITRATES.map(bitrate => ({ value: bitrate, label: String(bitrate) }))

/**
 * Automatic | Original | Fixed, with one follow-up row for the choice that needs it
 * (Priority for Automatic, Bitrate for Fixed). Both follow-ups stay mounted so
 * switching slides one closed and the other open instead of jumping.
 *
 * Without `server` this is the global setting ("Default quality" once there are
 * several servers). With `server`, it's that server's override, with "Use default" first.
 */
export function QualityControl({ server, servers }: { server?: ServerEntry; servers: ServerEntry[] }) {
  const { settings, error, save } = useStreamingQualitySettings()
  const source = server ? { provider: server.provider, sourceId: server.id } : undefined
  const sourceKey = source ? streamingQualitySourceKey(source) : null
  const global = settings?.global ?? 'original'
  const current: StreamingQuality | null = sourceKey ? settings?.overrides[sourceKey] ?? null : global

  // Remember the saved follow-up choices so switching away and back restores them.
  // Only saved values are remembered; the open row always shows what's saved.
  const [remembered, setRemembered] = useState<{ priority: AutomaticPriority; bitrate: QualityBitrate }>(
    { priority: 'balanced', bitrate: DEFAULT_FIXED_BITRATE })
  useEffect(() => {
    if (current === 'automatic-original' || current === 'automatic' || typeof current === 'number') {
      setRemembered(previous => ({ ...previous, ...qualityFollowUps(current, previous) }))
    }
  }, [current])
  const { priority, bitrate } = qualityFollowUps(current, remembered)

  const [applied, setApplied] = useState(false)
  const appliedTimer = useRef<number | null>(null)
  useEffect(() => () => { if (appliedTimer.current !== null) window.clearTimeout(appliedTimer.current) }, [])
  const [busy, setBusy] = useState(false)

  const choice: Choice = current === null ? 'default' : qualityMode(current)
  const copy = qualityCopy({
    global,
    overrides: settings?.overrides ?? {},
    servers: servers.map(item => ({ key: streamingQualitySourceKey({ provider: item.provider, sourceId: item.id }), name: item.name })),
    serverKey: sourceKey ?? undefined
  })
  // The default only reaches servers without their own setting.
  const reachesAnyServer = !!server || copy.overridden.length < servers.length
  const commit = async (next: StreamingQuality | null, target = source) => {
    // A click on what's already saved for this control changes nothing.
    if (target === source && next === current) return
    setBusy(true)
    const ok = await save(next, target)
    setBusy(false)
    if (!ok || (!target && !reachesAnyServer)) return
    // Said once after a change rather than always: it only matters right then.
    setApplied(true)
    if (appliedTimer.current !== null) window.clearTimeout(appliedTimer.current)
    appliedTimer.current = window.setTimeout(() => setApplied(false), 4000)
  }

  const { label, description } = copy
  // With one server there's no server page yet to change its own setting on, so
  // offer the way back here. It's never removed without the user asking.
  const lone = !server && servers.length === 1 && copy.overridden.length === 1 ? servers[0] : null

  const disabled = !settings || busy
  const open = (mode: QualityMode) => choice === mode
  return (
    <>
      <div className="servers-row servers-row-wrap">
        <div className="servers-row-text">
          <span className="servers-label">{label}</span>
          <span className="servers-sub">
            {description}
            {applied && <span className="servers-applied"> Applies from the next track.</span>}
          </span>
          {lone && (
            <button type="button" className="servers-link servers-link-inline" disabled={disabled}
              onClick={() => void commit(null, { provider: lone.provider, sourceId: lone.id })}>
              Use the default for {lone.name}
            </button>
          )}
          {error && <span className="servers-sub is-warn" role="alert">{error}</span>}
        </div>
        <SettingsSegmentedControl<Choice>
          ariaLabel={label}
          className={`servers-seg ${server ? 'servers-seg-server' : 'servers-seg-quality'}`}
          disabled={disabled}
          options={server ? SERVER_OPTIONS : MODE_OPTIONS}
          value={choice}
          onChange={next => void commit(next === 'default' ? null : qualityFromChoice(next, priority, bitrate))}
        />
      </div>
      <div className={`servers-reveal${open('automatic') ? ' is-open' : ''}`} inert={!open('automatic')}>
        <div className="servers-reveal-inner">
          <div className="servers-row servers-row-wrap servers-sub-row">
            <div className="servers-row-text">
              <span className="servers-label">Priority</span>
              <span className="servers-sub">What Automatic protects first when your connection dips.</span>
            </div>
            <SettingsSegmentedControl<AutomaticPriority>
              ariaLabel="Priority"
              className="servers-seg servers-seg-priority"
              disabled={disabled}
              options={PRIORITY_OPTIONS}
              value={priority}
              onChange={next => void commit(qualityFromChoice('automatic', next, bitrate))}
            />
          </div>
        </div>
      </div>
      <div className={`servers-reveal${open('fixed') ? ' is-open' : ''}`} inert={!open('fixed')}>
        <div className="servers-reveal-inner">
          <div className="servers-row servers-row-wrap servers-sub-row">
            <div className="servers-row-text">
              <span className="servers-label">Bitrate</span>
              <span className="servers-sub">A smaller Opus stream, when the server can convert.</span>
            </div>
            <div className="servers-control">
              <SettingsSegmentedControl<QualityBitrate>
                ariaLabel="Bitrate"
                className="servers-seg servers-seg-bitrate"
                disabled={disabled}
                options={BITRATE_OPTIONS}
                value={bitrate}
                onChange={next => void commit(qualityFromChoice('fixed', priority, next))}
              />
              <span className="servers-unit">kbps</span>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
