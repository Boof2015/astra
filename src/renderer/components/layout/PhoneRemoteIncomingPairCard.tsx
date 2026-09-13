import { useEffect, useState } from 'react'
import { usePhoneRemoteSettingsStore } from '../../stores/phoneRemoteSettingsStore'
import HardwarePairingDialog from '../devices/HardwarePairingDialog'

interface Props { variant?: 'modal' | 'zone-display' }

export default function PhoneRemoteIncomingPairCard({ variant = 'modal' }: Props) {
  const init = usePhoneRemoteSettingsStore(state => state.init)
  const incoming = usePhoneRemoteSettingsStore(state => state.pendingPairingRequests.find(request =>
    (request.pairingMode === 'pin' || request.pairingMode === 'code') && request.pin))
  const [now, setNow] = useState(Date.now())
  useEffect(() => { void init() }, [init])
  useEffect(() => {
    if(!incoming) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [incoming?.id])
  const remaining = incoming ? Math.max(0, Math.ceil((incoming.expiresAt - now) / 1000)) : 0
  if(!incoming?.pin || remaining <= 0) return null
  if(incoming.pairingMode === 'code') return <HardwarePairingDialog key={incoming.id} request={incoming}/>

  const card = <div className={`parallax-pair-card parallax-pair-card-${variant}`} role="alert" aria-live="polite">
    <div className="parallax-pair-card-kicker">Astra companion pair request</div>
    <div className="parallax-pair-card-host"><strong>{incoming.deviceName || 'Astra Mobile'}</strong><span className="parallax-pair-card-host-suffix">wants to pair</span></div>
    <div className="parallax-pair-card-pin" aria-label={`PIN ${incoming.pin}`}>{incoming.pin.split('').map((digit,index) => <span key={index} className="parallax-pair-card-pin-digit">{digit}</span>)}</div>
    <div className="parallax-pair-card-instructions">Enter this code in the requesting app.</div>
    <div className="parallax-pair-card-footnote">Requested: {incoming.requestedScopes.join(', ')}</div>
    <div className="parallax-pair-card-countdown">Expires in {Math.floor(remaining/60)}:{String(remaining%60).padStart(2,'0')}</div>
    <div className="parallax-pair-card-footnote">If this wasn't you, ignore.</div>
  </div>
  return variant === 'zone-display'
    ? <div className="parallax-pair-card-zone-overlay">{card}</div>
    : <div className="parallax-pair-card-modal-backdrop" role="dialog" aria-modal="true" aria-label="Pair companion">{card}</div>
}
