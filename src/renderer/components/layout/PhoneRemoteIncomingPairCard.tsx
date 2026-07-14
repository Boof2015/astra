import { useEffect, useState } from 'react'
import { usePhoneRemoteSettingsStore } from '../../stores/phoneRemoteSettingsStore'

interface Props {
  variant?: 'modal' | 'zone-display'
}

function useSecondsRemaining(expiresAtMs: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (expiresAtMs === null) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [expiresAtMs])
  if (expiresAtMs === null) return 0
  return Math.max(0, Math.ceil((expiresAtMs - now) / 1000))
}

function formatMmSs(seconds: number): string {
  const mm = Math.floor(seconds / 60)
  const ss = seconds % 60
  return `${mm}:${ss.toString().padStart(2, '0')}`
}

export default function PhoneRemoteIncomingPairCard({ variant = 'modal' }: Props) {
  const initPhoneRemote = usePhoneRemoteSettingsStore((s) => s.init)
  const incoming = usePhoneRemoteSettingsStore((s) =>
    s.pendingPairingRequests.find((request) => request.pairingMode === 'pin' && request.pin)
  )
  const remaining = useSecondsRemaining(incoming?.expiresAt ?? null)

  useEffect(() => {
    void initPhoneRemote()
  }, [initPhoneRemote])

  if (!incoming?.pin || remaining <= 0) return null

  const pinDigits = incoming.pin.split('')

  const card = (
    <div className={`parallax-pair-card parallax-pair-card-${variant}`} role="alert" aria-live="polite">
      <div className="parallax-pair-card-kicker">Astra companion pair request</div>
      <div className="parallax-pair-card-host">
        <strong>{incoming.deviceName || 'Astra Mobile'}</strong>
        <span className="parallax-pair-card-host-suffix">wants to pair</span>
      </div>
      <div className="parallax-pair-card-pin" aria-label={`PIN ${incoming.pin}`}>
        {pinDigits.map((digit, index) => (
          <span key={index} className="parallax-pair-card-pin-digit">{digit}</span>
        ))}
      </div>
      <div className="parallax-pair-card-instructions">
        Enter this code in the requesting app.
      </div>
      <div className="parallax-pair-card-footnote">
        Requested: {incoming.requestedScopes.join(', ')}
      </div>
      <div className="parallax-pair-card-countdown">
        Expires in {formatMmSs(remaining)}
      </div>
      <div className="parallax-pair-card-footnote">
        If this wasn't you, ignore.
      </div>
    </div>
  )

  if (variant === 'zone-display') {
    return <div className="parallax-pair-card-zone-overlay">{card}</div>
  }

  return (
    <div className="parallax-pair-card-modal-backdrop" role="dialog" aria-modal="true">
      {card}
    </div>
  )
}
