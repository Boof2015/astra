import { useEffect, useState } from 'react'
import { useParallaxStore } from '../../stores/parallaxStore'

// §20 / §14.1.5 Commit 4. Sink-side display of an incoming pair-request. The sink listener has
// already auto-generated a PIN and pushed it through status (`status.sink.incomingPairRequest`).
// This component just renders it — no accept/deny buttons. Per §20.12, the PIN being on screen
// IS the proof of physical access; users who don't want to pair just don't tell the host the
// PIN, the request expires after 90s, sink returns to idle.
//
// Two variants:
//   - 'modal' (default): centered modal over the normal Astra shell.
//   - 'zone-display': inline overlay sized to fit inside the Zone Display surface.

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

export default function ParallaxIncomingPairCard({ variant = 'modal' }: Props) {
  const incoming = useParallaxStore((s) => s.status?.sink.incomingPairRequest ?? null)
  const remaining = useSecondsRemaining(incoming?.expiresAtMs ?? null)
  const [submitting, setSubmitting] = useState(false)

  if (!incoming) return null

  // Split the PIN into individual digits so each can render in its own slot — easier to read at
  // a glance + matches the Bluetooth pair-card mental model the spec calls out.
  const pinDigits = incoming.pin.split('')

  const card = (
    <div className={`parallax-pair-card parallax-pair-card-${variant}`} role="alert" aria-live="polite">
      <div className="parallax-pair-card-kicker">Pair request</div>
      <div className="parallax-pair-card-host">
        <strong>{incoming.hostName || 'Unknown host'}</strong>
        <span className="parallax-pair-card-host-suffix">wants to pair</span>
      </div>
      <div className="parallax-pair-card-pin" aria-label={`PIN ${incoming.pin}`}>
        {pinDigits.map((digit, index) => (
          <span key={index} className="parallax-pair-card-pin-digit">{digit}</span>
        ))}
      </div>
      <div className="parallax-pair-card-instructions">
        {incoming.awaitingApproval
          ? 'The host matched this code. Approve the connection to finish pairing.'
          : 'Enter this code on the host, then approve the connection here.'}
      </div>
      <div className="parallax-pair-card-countdown">
        Expires in {formatMmSs(remaining)}
      </div>
      <div className="parallax-pair-card-footnote">
        If this wasn't you, reject the request.
      </div>
      <div className="parallax-pair-card-actions">
        <button
          type="button"
          className="parallax-pair-card-button parallax-pair-card-button-secondary"
          disabled={submitting}
          onClick={() => {
            setSubmitting(true)
            void window.electronAPI.parallax.cancelIncomingPair().finally(() => setSubmitting(false))
          }}
        >
          Reject
        </button>
        {incoming.awaitingApproval && (
          <button
            type="button"
            className="parallax-pair-card-button parallax-pair-card-button-primary"
            disabled={submitting}
            onClick={() => {
              setSubmitting(true)
              void window.electronAPI.parallax.approveIncomingPair().finally(() => setSubmitting(false))
            }}
          >
            Approve
          </button>
        )}
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
