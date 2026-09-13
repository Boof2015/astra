import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { PhoneRemotePendingPairingRequest } from '../../../types/phoneRemote'
import { usePhoneRemoteSettingsStore } from '../../stores/phoneRemoteSettingsStore'
import HardwareIllustration from './HardwareIllustration'
import './devices.css'

export default function HardwarePairingDialog({ request }: { request: PhoneRemotePendingPairingRequest }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const decline = useRef<HTMLButtonElement>(null)
  const approve = useRef<HTMLButtonElement>(null)
  const remaining = Math.max(0, Math.ceil((request.expiresAt - now) / 1000))
  const refresh = usePhoneRemoteSettingsStore(state => state.refresh)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    decline.current?.focus()
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => { clearInterval(timer); if(previous?.isConnected) previous.focus() }
  }, [request.id])
  async function respond(approved: boolean) {
    if(busy) return
    setBusy(true);setError('')
    try {
      const result = await (approved ? window.electronAPI.phoneRemote.approvePairingRequest(request.id) : window.electronAPI.phoneRemote.rejectPairingRequest(request.id))
      if(!result) throw new Error('This request has expired. Start again on your device.')
      await refresh()
    } catch(cause) { setError(cause instanceof Error ? cause.message : 'Could not connect. Try again.');setBusy(false) }
  }
  function keyDown(event: KeyboardEvent) {
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();void respond(false)}
    if(event.key==='Tab'){event.preventDefault();(document.activeElement===decline.current?approve.current:decline.current)?.focus()}
  }
  const permissions = [request.requestedScopes.includes('playback-control') ? 'Control playback and queue' : 'See playback and queue', ...(request.requestedScopes.includes('library-search') ? ['Browse playlists and find songs'] : [])]
  return <div className="hardware-pair-backdrop"><div className="hardware-pair-dialog" role="dialog" aria-modal="true" aria-labelledby="hardware-pair-title" aria-describedby="hardware-pair-instructions" onKeyDown={keyDown}>
    <div className="hardware-pair-header"><span className="hardware-overline">Connect a device</span><span className="hardware-pair-time">{remaining > 0 ? `${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}` : 'Expired'}</span></div>
    <div className="hardware-pair-body"><HardwareIllustration modelId={request.deviceInfo?.modelId}/><div className="hardware-pair-copy"><h2 id="hardware-pair-title">{request.deviceName}</h2><p id="hardware-pair-instructions">Check that your device shows this code.</p><div className="hardware-pair-code" aria-label={`Code ${request.pin?.split('').join(' ')}`}>{request.pin?.slice(0,3)} {request.pin?.slice(3)}</div></div></div>
    <div className="hardware-pair-permissions"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" stroke="currentColor" strokeWidth="1.5"/><path d="m8 12 3 3 5-6" stroke="currentColor" strokeWidth="1.5"/></svg><span>{permissions.join(' · ')}</span></div>
    {error && <div className="hardware-error" role="alert">{error}</div>}
    <div className="hardware-pair-actions"><button ref={decline} className="hardware-button" disabled={busy} onClick={() => void respond(false)}>Cancel</button><button ref={approve} className="hardware-button hardware-button-primary" disabled={busy || remaining===0} onClick={() => void respond(true)}>{busy ? 'Connecting…' : 'Codes match — Connect'}</button></div>
  </div></div>
}
