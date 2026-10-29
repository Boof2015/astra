import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { StratumManualCheck, StratumStatus } from '../../../../types/stratum'
import type { PresencePhase } from '../../../hooks/usePresence'
import { ServerWindow, Spinner } from './ServerWindow'
import { cleanIpcError } from './serverModel'
import type { ServerEntry } from './useServers'

export function StratumConnectionWindow({ server, status, phase, onClose, onConnected }: {
  server: ServerEntry
  status: StratumStatus | null
  phase: PresencePhase
  onClose: () => void
  onConnected: (status: StratumStatus) => void
}) {
  const [address, setAddress] = useState(status?.connection === 'manual' ? status.endpoint ?? '' : '')
  const [proposal, setProposal] = useState<StratumManualCheck | null>(null)
  const [busy, setBusy] = useState<'checking' | 'connecting' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const active = useRef(true)
  const working = useRef(false)
  const trustButton = useRef<HTMLButtonElement>(null)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => { if (proposal) trustButton.current?.focus() }, [proposal])

  const connect = async (event?: FormEvent) => {
    event?.preventDefault()
    if (working.current || phase === 'exiting' || !server.enabled) return
    working.current = true
    setBusy(proposal ? 'connecting' : 'checking'); setError(null)
    try {
      const checked = proposal ?? await window.electronAPI.stratum.inspectManual(server.id, address.trim())
      if (!active.current) return
      if (!proposal && checked.requiresTrust) { setProposal(checked); return }
      setBusy('connecting')
      const value = await window.electronAPI.stratum.connectManual(server.id, checked.token)
      if (active.current) onConnected(value)
    } catch (failure) {
      if (active.current) {
        setProposal(null)
        setError(cleanIpcError(failure, 'Could not connect to Sidecar.'))
      }
    } finally {
      working.current = false
      if (active.current) setBusy(null)
    }
  }
  const useDiscovery = async () => {
    if (working.current || phase === 'exiting') return
    working.current = true; setBusy('checking'); setError(null)
    try {
      const value = await window.electronAPI.stratum.forgetManual(server.id)
      if (active.current) onConnected(value)
    } catch (failure) { if (active.current) setError(cleanIpcError(failure, 'Could not change the connection.')) }
    finally { working.current = false; if (active.current) setBusy(null) }
  }

  return <ServerWindow phase={phase} title={proposal ? 'Trust this Sidecar?' : 'Connect Sidecar'} subtitle={server.name}
    busy={!!busy} onClose={onClose} footer={<>
      <button type="button" className="servers-btn" disabled={!!busy} onClick={() => proposal ? setProposal(null) : onClose()}>
        {proposal ? 'Back' : 'Cancel'}
      </button>
      <button ref={trustButton} type="button" className="servers-btn is-accent" disabled={!!busy || !server.enabled || (!proposal && !address.trim())}
        onClick={() => void connect()}>
        {busy ? <><Spinner />{busy === 'checking' ? 'Checking…' : 'Connecting…'}</> : proposal ? 'Trust and enable Stratum' : 'Connect and enable'}
      </button>
    </>}>
    {proposal ? <>
      <p className="servers-stratum-address">{proposal.endpoint}</p>
      <p className="servers-window-text">{proposal.identityChanged
        ? 'Sidecar’s identity has changed. Confirm this change was expected before trusting the connection again.'
        : 'This Sidecar uses a self-signed certificate. Continue if you recognize and trust this address.'}</p>
      <p className="servers-hint">Astra will remember its identity and use your Navidrome sign-in to connect.</p>
      <details className="servers-stratum-identity"><summary tabIndex={0}>Identity details</summary>
        <span>Public key · SHA-256</span>
        <code>{proposal.fingerprint.match(/.{1,4}/g)?.join(' ')}</code>
      </details>
    </> : <>
      <form className="servers-form" onSubmit={event => void connect(event)}>
        <label className="servers-field">
          <span>Sidecar address</span>
          <input className="servers-input is-mono" data-autofocus type="text" value={address} disabled={!!busy}
            autoComplete="off" spellCheck={false} placeholder="https://sidecar.home:7843"
            onChange={event => setAddress(event.target.value)} />
        </label>
        <button type="submit" hidden />
      </form>
      <p className="servers-hint">Enter Sidecar’s HTTPS address, including any path. Astra uses your existing Navidrome sign-in.</p>
      {status?.connection === 'manual' && <button type="button" className="servers-link" disabled={!!busy} onClick={() => void useDiscovery()}>
        Use discovery instead
      </button>}
    </>}
    {error && <p className="servers-error" role="alert">{error}</p>}
  </ServerWindow>
}
