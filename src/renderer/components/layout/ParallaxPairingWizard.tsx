import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PARALLAX_SINK_DEFAULT_PORT,
  type ParallaxDiscoveredSink,
  type ParallaxDiscoveryEvent,
  type ParallaxPairedSink
} from '../../../types/parallax'
import { useParallaxStore } from '../../stores/parallaxStore'
import { ParallaxPairingPrompt } from './ParallaxPairingPrompt'

// §20 / §14.1.5 Commit 4. Host-side "Add Sink" wizard. Two phases:
//
//   1. Browse — mDNS-discovered sinks + manual URL entry. Clicking a row (or submitting a URL)
//      kicks `initiatePair` and transitions to phase 2.
//   2. PIN entry — user reads PIN from the sink's screen and types it here. Submission calls
//      `submitPairPin`. On success: show "Paired" briefly, then close.
//
// Spec calls (Codex round 1 amendments): `pair-request` carries no credentials; the candidate
// (sinkId, token) is local until PIN submission. Wizard counts wrong-PIN attempts locally
// because the sink responds `401 {error:'pin'}` without leaking remaining attempts.

interface Props {
  onClose: () => void
}

type WizardPhase =
  | { kind: 'browse' }
  | { kind: 'initiating'; baseUrl: string }
  | {
      kind: 'pin-entry'
      pairingId: string
      sinkBaseUrl: string
      sinkName: string
      sinkParallaxEndpointUuid: string | null
      expiresAtMs: number
      pinInput: string
      attempts: number
      submitting: boolean
    }
  | { kind: 'success'; sinkName: string }
  // `retryBaseUrl` carries the sink we were mid-pairing so the error screen can offer a one-tap
  // "Try again" that re-requests a PIN, instead of dead-ending back at the browse list.
  | { kind: 'error'; message: string; retryBaseUrl?: string }

function pickSecondsRemaining(expiresAtMs: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAtMs - now) / 1000))
}

function formatMmSs(seconds: number): string {
  const mm = Math.floor(seconds / 60)
  const ss = seconds % 60
  return `${mm}:${ss.toString().padStart(2, '0')}`
}

function sinkRowKey(sink: ParallaxDiscoveredSink): string {
  return sink.endpointUuid || `${sink.address}:${sink.port}`
}

export default function ParallaxPairingWizard({ onClose }: Props) {
  const pairedSinks = useParallaxStore((s) => s.pairedSinks)
  const [discovered, setDiscovered] = useState<Map<string, ParallaxDiscoveredSink>>(() => new Map())
  const [manualUrl, setManualUrl] = useState('')
  const [phase, setPhase] = useState<WizardPhase>({ kind: 'browse' })
  const pinInputRef = useRef<HTMLInputElement | null>(null)
  // Codex round 1 finding (low): the unmount cleanup below needs the LATEST phase to know
  // whether to fire `cancelPair`. Using `[phase]` as deps would re-run the cleanup on every
  // phase change, which is wrong (we'd cancel the candidate every state transition). A ref
  // tracking the live phase is the correct shape — cleanup reads it at unmount time.
  const phaseRef = useRef<WizardPhase>(phase)
  useEffect(() => { phaseRef.current = phase }, [phase])

  // Subscribe to mDNS discovery events. Lifetime = wizard open; mount toggles `startDiscoveryBrowse`
  // on, unmount toggles off. Idempotent on main — fine if user closes/reopens the wizard fast.
  useEffect(() => {
    const unsubscribe = window.electronAPI.parallax.onDiscoveryEvent((event: ParallaxDiscoveryEvent) => {
      setDiscovered((prev) => {
        const next = new Map(prev)
        if (event.type === 'added') {
          next.set(sinkRowKey(event.sink), event.sink)
        } else {
          // Removed events arrive with endpointUuid || address+port; match on whichever the row
          // was indexed by.
          const key = event.endpointUuid || `${event.address}:${event.port}`
          next.delete(key)
        }
        return next
      })
    })
    void window.electronAPI.parallax.startDiscoveryBrowse()
    return () => {
      unsubscribe()
      void window.electronAPI.parallax.stopDiscoveryBrowse()
    }
  }, [])

  // Auto-focus the PIN input when we enter pin-entry.
  useEffect(() => {
    if (phase.kind === 'pin-entry') pinInputRef.current?.focus()
  }, [phase.kind])

  // Cancel any in-flight host candidate when the wizard unmounts (user navigates away
  // mid-flow without using Cancel/×). Reads the LATEST phase from the ref so the cleanup is
  // honest about what was active at unmount time, not at first render.
  useEffect(() => {
    return () => {
      const livePhase = phaseRef.current
      if (livePhase.kind === 'pin-entry') {
        void window.electronAPI.parallax.cancelPair(livePhase.pairingId)
      }
    }
  }, [])

  // Live countdown re-render at 1Hz while in pin-entry phase. We don't actually expire client-side
  // (the sink does that and the next confirm will 410); the tick just keeps the UI honest.
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (phase.kind !== 'pin-entry') return
    const id = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [phase.kind])

  const pairedByEndpointUuid = useMemo(() => {
    const map = new Map<string, ParallaxPairedSink>()
    for (const sink of pairedSinks) {
      if (sink.revokedAt) continue
      if (sink.remoteParallaxEndpointUuid) map.set(sink.remoteParallaxEndpointUuid, sink)
    }
    return map
  }, [pairedSinks])

  const discoveredList = useMemo(() => Array.from(discovered.values())
    .sort((left, right) => left.name.localeCompare(right.name)), [discovered])

  const handleInitiate = useCallback(async (baseUrl: string) => {
    setPhase({ kind: 'initiating', baseUrl })
    try {
      const result = await window.electronAPI.parallax.initiatePair(baseUrl)
      setPhase({
        kind: 'pin-entry',
        pairingId: result.pairingId,
        sinkBaseUrl: baseUrl,
        sinkName: result.sinkName,
        sinkParallaxEndpointUuid: result.sinkParallaxEndpointUuid,
        expiresAtMs: Date.now() + result.expiresInSeconds * 1000,
        pinInput: '',
        attempts: 0,
        submitting: false
      })
    } catch (error) {
      setPhase({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Pair request failed.',
        retryBaseUrl: baseUrl
      })
    }
  }, [])

  const handleSubmitPin = useCallback(async () => {
    if (phase.kind !== 'pin-entry') return
    if (phase.submitting) return
    const trimmedPin = phase.pinInput.replace(/\s+/g, '')
    // Codex round 1 finding (medium): PINs are always exactly 6 digits (§20.7). Submitting a
    // partial PIN would burn one of the sink's 3 wrong-attempt slots and could lock the user
    // out for the rest of the 90s window. Guard at submit AND at the disabled-button check
    // below.
    if (trimmedPin.length !== 6) return
    setPhase({ ...phase, submitting: true })
    try {
      const result = await window.electronAPI.parallax.submitPairPin(phase.pairingId, trimmedPin)
      setPhase({ kind: 'success', sinkName: result.sinkName })
      setTimeout(onClose, 1500)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Pair confirm failed.'
      const isWrongPin = /401|PIN|pin/.test(message)
      if (isWrongPin) {
        setPhase({ ...phase, attempts: phase.attempts + 1, pinInput: '', submitting: false })
        return
      }
      setPhase({ kind: 'error', message, retryBaseUrl: phase.sinkBaseUrl })
    }
  }, [phase, onClose])

  const handleCancel = useCallback(() => {
    if (phase.kind === 'pin-entry') {
      void window.electronAPI.parallax.cancelPair(phase.pairingId)
    }
    onClose()
  }, [phase, onClose])

  const handleManualSubmit = useCallback((event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = manualUrl.trim()
    if (!trimmed) return
    let url = trimmed
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`
    // A bare IP/hostname has no port, so it would hit :80 and fail. Default to the sink port
    // (38404) when the user didn't type one — covers "192.168.1.42" and "http://host".
    try {
      const parsed = new URL(url)
      if (!parsed.port) parsed.port = String(PARALLAX_SINK_DEFAULT_PORT)
      url = parsed.toString()
    } catch {
      // Not parseable — let initiatePair surface the error.
    }
    void handleInitiate(url.replace(/\/+$/, ''))
  }, [manualUrl, handleInitiate])

  return (
    <div
      className="parallax-pairing-wizard-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Add a speaker"
      onClick={(event) => { if (event.target === event.currentTarget) handleCancel() }}
    >
      <div className="parallax-pairing-wizard-card">
        <div className="parallax-pairing-wizard-head">
          <span className="parallax-pairing-wizard-title">Add a speaker</span>
          <button
            type="button"
            className="parallax-pairing-wizard-close"
            onClick={handleCancel}
            aria-label="Close"
          >×</button>
        </div>

        {phase.kind === 'browse' && (
          <>
            <div className="parallax-pairing-wizard-section-head">
              <span className="parallax-pairing-wizard-section-label">On this network</span>
              <span className="parallax-pairing-wizard-section-count">{discoveredList.length}</span>
            </div>
            <div className="parallax-pairing-wizard-list">
              {discoveredList.length === 0 ? (
                <div className="parallax-pairing-wizard-empty">Looking for speakers on this network…</div>
              ) : (
                discoveredList.map((sink) => {
                  const matchedPair = sink.endpointUuid ? pairedByEndpointUuid.get(sink.endpointUuid) : undefined
                  return (
                    <button
                      key={sinkRowKey(sink)}
                      type="button"
                      className="parallax-pairing-wizard-row"
                      disabled={!sink.compatible}
                      onClick={() => void handleInitiate(sink.baseUrl)}
                    >
                      <div className="parallax-pairing-wizard-row-main">
                        <span className="parallax-pairing-wizard-row-name">{sink.name}</span>
                        <span className="parallax-pairing-wizard-row-meta">
                          {sink.address}:{sink.port}
                        </span>
                      </div>
                      {!sink.compatible ? (
                        <span className="parallax-pairing-wizard-row-badge">Update required</span>
                      ) : matchedPair && (
                        <span className="parallax-pairing-wizard-row-badge">
                          Already paired{matchedPair.name && matchedPair.name !== sink.name ? ` as “${matchedPair.name}”` : ''}
                        </span>
                      )}
                    </button>
                  )
                })
              )}
            </div>

            <div className="parallax-pairing-wizard-divider">or</div>

            <form className="parallax-pairing-wizard-manual" onSubmit={handleManualSubmit}>
              <label className="parallax-pairing-wizard-manual-label">Add by address</label>
              <div className="parallax-pairing-wizard-manual-row">
                <input
                  type="text"
                  className="parallax-pairing-wizard-manual-input"
                  placeholder="http://192.168.1.42:38404"
                  value={manualUrl}
                  onChange={(event) => setManualUrl(event.target.value)}
                />
                <button type="submit" className="settings-btn settings-btn-primary" disabled={!manualUrl.trim()}>
                  Pair
                </button>
              </div>
            </form>
          </>
        )}

        {phase.kind === 'initiating' && (
          <div className="parallax-pairing-wizard-loading">
            Connecting to {phase.baseUrl}…
          </div>
        )}

        {phase.kind === 'pin-entry' && (
          <PinEntryPhase
            sinkName={phase.sinkName}
            pinInput={phase.pinInput}
            attempts={phase.attempts}
            submitting={phase.submitting}
            secondsRemaining={pickSecondsRemaining(phase.expiresAtMs, Date.now())}
            pinInputRef={pinInputRef}
            onChange={(value) => setPhase({ ...phase, pinInput: value })}
            onSubmit={handleSubmitPin}
            onCancel={handleCancel}
          />
        )}

        {phase.kind === 'success' && (
          <div className="parallax-pairing-wizard-success">
            <div className="parallax-pairing-wizard-success-kicker">Paired</div>
            <div className="parallax-pairing-wizard-success-name">{phase.sinkName}</div>
          </div>
        )}

        {phase.kind === 'error' && (
          <div className="parallax-pairing-wizard-error">
            <div className="parallax-pairing-wizard-error-message">{phase.message}</div>
            <div className="parallax-pairing-wizard-row-actions">
              {phase.retryBaseUrl && (
                <button
                  type="button"
                  className="settings-btn settings-btn-primary"
                  onClick={() => { const url = phase.retryBaseUrl; if (url) void handleInitiate(url) }}
                >
                  Try again
                </button>
              )}
              <button type="button" className="settings-btn" onClick={() => setPhase({ kind: 'browse' })}>
                Back
              </button>
              <button type="button" className="settings-btn" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

interface PinEntryProps {
  sinkName: string
  pinInput: string
  attempts: number
  submitting: boolean
  secondsRemaining: number
  pinInputRef: React.MutableRefObject<HTMLInputElement | null>
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}

function PinEntryPhase({
  sinkName, pinInput, attempts, submitting, secondsRemaining, pinInputRef, onChange, onSubmit, onCancel
}: PinEntryProps) {
  return (
    <div className="parallax-pairing-wizard-pin">
      <div className="parallax-pairing-wizard-pin-prompt">
        <ParallaxPairingPrompt sinkName={sinkName} submitting={submitting} />
      </div>
      <input
        ref={pinInputRef}
        type="text"
        inputMode="numeric"
        maxLength={6}
        className="parallax-pairing-wizard-pin-input"
        disabled={submitting}
        value={pinInput}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, ''))}
        onKeyDown={(event) => { if (event.key === 'Enter') onSubmit() }}
      />
      <div className="parallax-pairing-wizard-pin-meta">
        Expires in {formatMmSs(secondsRemaining)}
        {attempts > 0 && <span className="parallax-pairing-wizard-pin-attempts"> · Wrong PIN. Try again.</span>}
      </div>
      <div className="parallax-pairing-wizard-row-actions">
        <button type="button" className="settings-btn" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="settings-btn settings-btn-primary"
          disabled={pinInput.length !== 6 || submitting}
          onClick={onSubmit}
        >
          {submitting ? 'Pairing…' : 'Pair'}
        </button>
      </div>
    </div>
  )
}
