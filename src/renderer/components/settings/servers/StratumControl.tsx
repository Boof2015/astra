import { useEffect, useRef, useState } from 'react'
import type { StratumStatus } from '../../../../types/stratum'
import { ServerSwitch } from './ServerParts'
import { cleanIpcError } from './serverModel'
import type { ServerEntry } from './useServers'

/** Discovery is credential-free at Sidecar. Only the user's switch authorizes sign-in. */
export function StratumControl({ server }: { server: ServerEntry }) {
  const [status, setStatus] = useState<StratumStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  useEffect(() => {
    const token = ++generation.current
    setStatus(null); setError(null); setBusy(false)
    if (server.provider !== 'subsonic') return
    const current = () => generation.current === token
    const unsubscribe = window.electronAPI.stratum.onChanged(value => {
      if (current() && value.sourceId === server.id) setStatus(value)
    })
    void window.electronAPI.stratum.status(server.id).then(async value => {
      if (!current()) return
      setStatus(value)
      if (server.enabled && value.state === 'unchecked') {
        const found = await window.electronAPI.stratum.discover(server.id)
        if (current()) setStatus(found)
      }
    }).catch(failure => { if (current()) setError(cleanIpcError(failure, 'Could not check Stratum.')) })
    return () => { ++generation.current; unsubscribe() }
  }, [server.id, server.provider, server.enabled, server.address, server.user])

  if (server.provider !== 'subsonic') return null
  const checking = busy || status?.state === 'checking'
  const run = async (enabled?: boolean) => {
    if (checking) return
    const token = generation.current
    setBusy(true); setError(null)
    try {
      const value = enabled === undefined ? await window.electronAPI.stratum.discover(server.id)
        : await window.electronAPI.stratum.setEnabled(server.id, enabled)
      if (generation.current === token) setStatus(value)
    } catch (failure) {
      if (generation.current === token) setError(cleanIpcError(failure, 'Could not update Stratum.'))
    } finally { if (generation.current === token) setBusy(false) }
  }
  const message = !server.enabled ? 'Turn on this server to use Stratum.' : checking ? 'Checking Sidecar…'
    : status?.enabled ? 'Enabled · Applies to new playback.' : status?.state === 'available' ? 'Available through Sidecar.'
      : status?.state === 'unavailable' ? 'No Sidecar announcement found.' : 'Adaptive streaming through Sidecar.'
  return <div className="servers-stratum">
    <div className="servers-row">
      <div className="servers-row-text">
        <span className="servers-label">Stratum</span>
        <span className="servers-sub" role="status">{message}</span>
      </div>
      {(status?.enabled || status?.state === 'available') && <ServerSwitch checked={!!status.enabled}
        label={`Enable Stratum for ${server.name}`} disabled={checking || (!server.enabled && !status.enabled)} onChange={value => { void run(value) }} />}
      <button type="button" className="servers-link" disabled={checking || !server.enabled} onClick={() => { void run() }}>Check again</button>
    </div>
    {(error || status?.error) && <p className="servers-error" role="alert">{error ?? status?.error}</p>}
    {(status?.enabled || status?.state === 'available') && <p className="servers-hint">
      Standard output · Original, Automatic, 64 or 128 kbps. Other formats and settings use normal streaming.
    </p>}
  </div>
}
