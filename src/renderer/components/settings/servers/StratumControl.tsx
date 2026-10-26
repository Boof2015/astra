import { useEffect, useRef, useState } from 'react'
import type { StratumStatus } from '../../../../types/stratum'
import { ServerSwitch } from './ServerParts'
import { cleanIpcError } from './serverModel'
import type { ServerEntry } from './useServers'
import StratumEnableWave from './StratumEnableWave'

/** Discovery is credential-free at Sidecar. Only the user's switch authorizes sign-in. */
export function StratumControl({ server }: { server: ServerEntry }) {
  const [status, setStatus] = useState<StratumStatus | null>(null)
  const [known, setKnown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [celebrate, setCelebrate] = useState(false)
  useEffect(() => {
    if (!celebrate) return
    const timer = setTimeout(() => setCelebrate(false), 1900)
    return () => clearTimeout(timer)
  }, [celebrate])
  const generation = useRef(0)
  const accept = (value: StratumStatus) => {
    setStatus(value)
    setKnown(previous => previous || value.enabled || value.state === 'available')
  }
  useEffect(() => {
    const token = ++generation.current
    setStatus(null); setKnown(false); setError(null); setBusy(false); setCelebrate(false)
    if (server.provider !== 'subsonic') return
    const current = () => generation.current === token
    const unsubscribe = window.electronAPI.stratum.onChanged(value => {
      if (current() && value.sourceId === server.id) {
        accept(value)
        if (!value.enabled || value.state === 'error') setCelebrate(false)
      }
    })
    void window.electronAPI.stratum.status(server.id).then(async value => {
      if (!current()) return
      accept(value)
      if (server.enabled && value.state === 'unchecked') {
        const found = await window.electronAPI.stratum.discover(server.id)
        if (current()) accept(found)
      }
    }).catch(failure => { if (current()) setError(cleanIpcError(failure, 'Could not check Stratum.')) })
    return () => { ++generation.current; unsubscribe() }
  }, [server.id, server.provider, server.enabled, server.address, server.user])

  if (server.provider !== 'subsonic') return null
  const checking = busy || status?.state === 'checking'
  const run = async (enabled?: boolean) => {
    if (checking) return
    const token = generation.current
    setBusy(true); setError(null); setCelebrate(false)
    try {
      // A failed identity check intentionally forgets discovery when disabled.
      // Keep the familiar switch, and recheck before the next explicit enable.
      if (enabled && status?.state !== 'available' && !status?.enabled) {
        const found = await window.electronAPI.stratum.discover(server.id)
        if (generation.current !== token) return
        accept(found)
        if (found.state !== 'available') return
      }
      const value = enabled === undefined ? await window.electronAPI.stratum.discover(server.id)
        : await window.electronAPI.stratum.setEnabled(server.id, enabled)
      if (generation.current === token) {
        accept(value)
        if (enabled === true && value.enabled && value.state === 'enabled') setCelebrate(true)
      }
    } catch (failure) {
      if (generation.current === token) setError(cleanIpcError(failure, 'Could not update Stratum.'))
    } finally { if (generation.current === token) setBusy(false) }
  }
  const message = !server.enabled ? 'Turn on this server to use Stratum.' : checking ? 'Checking Sidecar…'
    : status?.enabled ? 'Enabled · Applies to new playback.' : status?.state === 'available' ? 'Available through Sidecar.'
      : status?.state === 'unavailable' ? 'No Sidecar announcement found.' : 'Adaptive streaming through Sidecar.'
  const healthy = status?.state === 'enabled' || status?.state === 'available'
  return <div className={`servers-stratum${celebrate ? ' is-just-enabled' : ''}`}>
    {celebrate && <StratumEnableWave />}
    <div className="servers-row">
      <div className="servers-row-text">
        <span className="servers-label">Stratum</span>
        <span className="servers-sub" role="status">{message}</span>
      </div>
      {known && <ServerSwitch checked={!!status?.enabled}
        label={`Enable Stratum for ${server.name}`} disabled={checking || (!server.enabled && !status?.enabled)} onChange={value => { void run(value) }} />}
      {(!healthy || error) && <button type="button" className="servers-link" disabled={checking || !server.enabled} onClick={() => { void run() }}>Check again</button>}
    </div>
    {(error || status?.error) && <p className="servers-error" role="alert">{error ?? status?.error}</p>}
    {(status?.enabled || status?.state === 'available') && <p className="servers-hint">
      Standard or Exclusive output · Original, Automatic, 64 or 128 kbps. Other formats and settings use normal streaming.
    </p>}
  </div>
}
