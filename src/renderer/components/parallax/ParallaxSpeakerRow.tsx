import { useEffect, useRef, useState } from 'react'
import { useParallaxStore } from '../../stores/parallaxStore'
import { usePlayerStore } from '../../stores/playerStore'
import type { ParallaxConnectedSinkState, ParallaxPairedSink } from '../../../types/parallax'
import {
  clampParallaxTrimMs,
  formatParallaxLastSeen,
  formatParallaxTrimMs,
  stepParallaxTrimMs
} from './parallaxHelpers'

// One uninterrupted tone-start window covers the group lead and a mature predictor anchor set.
// It applies to every calibration run so a previously-known device cannot expose phase-1 trim.
const TONE_SYNC_WINDOW_MS = 5000

function formatSecondsCentis(ms: number): string {
  const total = Math.max(0, ms)
  const seconds = Math.floor(total / 1000)
  const centis = Math.floor((total % 1000) / 10)
  return `${seconds}.${centis.toString().padStart(2, '0')}`
}

interface ParallaxSpeakerRowProps {
  sink: ParallaxPairedSink
  connected: ParallaxConnectedSinkState | null
  activeStreamLabel: string
  notify: (message: string) => void
}

/**
 * Decluttered paired-speaker row. Name + status sit on the surface; destructive/rare actions move
 * into a ⋯ overflow menu, and trim hides behind a collapsible "Tune" panel (the deeper trim UX
 * lands here later). Trim edit base is the PERSISTED host intent, not the sink's echoed
 * `appliedAdvanceMs` (which lags a telemetry tick) — see the §14.1.1 note in the old panel.
 */
export default function ParallaxSpeakerRow({ sink, connected, activeStreamLabel, notify }: ParallaxSpeakerRowProps) {
  const {
    renamePairedSink,
    revokePairedSink,
    clearHostPresenceCache,
    setSinkTrim,
    setSinkPlaybackEnabled,
    isTestToneActive,
    testToneSinkId,
    testToneStartedAtMs,
    startTestTone,
    stopTestTone
  } = useParallaxStore()
  const isPlaying = usePlayerStore((s) => s.playbackState === 'playing')
  const testingThis = isTestToneActive && testToneSinkId === sink.id

  const [menuOpen, setMenuOpen] = useState(false)
  const [tuneOpen, setTuneOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameInput, setRenameInput] = useState(sink.name)
  const [, forceTick] = useState(0)
  const syncUntil = testingThis && testToneStartedAtMs !== null
    ? testToneStartedAtMs + TONE_SYNC_WINDOW_MS
    : null
  useEffect(() => {
    if (syncUntil === null) return
    const id = window.setInterval(() => {
      if (Date.now() >= syncUntil) window.clearInterval(id)
      forceTick((n) => n + 1)
    }, 50)
    return () => window.clearInterval(id)
  }, [syncUntil])
  const syncRemainingMs = syncUntil !== null ? syncUntil - Date.now() : 0
  const synchronizing = testingThis && syncRemainingMs > 0

  const online = Boolean(connected?.online)
  const playbackEnabled = sink.playbackEnabled !== false
  const outputDeviceId = connected?.outputDeviceId ?? null
  const outputDeviceLabel = connected?.outputDeviceLabel ?? null
  const persistedTrim = outputDeviceId
    ? (sink.trims ?? []).find((t) => t.outputDeviceId === outputDeviceId)
    : undefined
  const persistedAdvanceMs = persistedTrim?.advanceMs ?? 0
  const persistedAdvanceRef = useRef(persistedAdvanceMs)
  persistedAdvanceRef.current = persistedAdvanceMs
  const desiredAdvanceRef = useRef(persistedAdvanceMs)
  const lastSubmittedAdvanceRef = useRef(persistedAdvanceMs)
  const trimWriteInFlightRef = useRef(false)
  const [optimisticAdvanceMs, setOptimisticAdvanceMs] = useState<number | null>(null)
  useEffect(() => {
    if (trimWriteInFlightRef.current) return
    desiredAdvanceRef.current = persistedAdvanceMs
    lastSubmittedAdvanceRef.current = persistedAdvanceMs
    setOptimisticAdvanceMs(null)
  }, [outputDeviceId, persistedAdvanceMs])
  const effectiveAdvanceMs = optimisticAdvanceMs ?? persistedAdvanceMs
  const sinkAppliedAdvanceMs = connected?.appliedAdvanceMs
  const canEditTrim = Boolean(outputDeviceId)
  const echoMismatch = canEditTrim
    && typeof sinkAppliedAdvanceMs === 'number'
    && Math.abs(sinkAppliedAdvanceMs - effectiveAdvanceMs) > 0.5
  const lastSeen = connected?.lastSeenAt ?? sink.lastSeenAt
  const rttLabel = typeof connected?.rttMs === 'number' ? `${Math.round(connected.rttMs)} ms RTT` : 'RTT unknown'

  const statusLine = online
    ? playbackEnabled
      ? [rttLabel, activeStreamLabel].filter(Boolean).join(' · ')
      : 'Connected · Not selected for playback'
    : playbackEnabled
      ? `Offline · Will play when reconnected · last seen ${formatParallaxLastSeen(lastSeen)}`
      : `Offline · Not selected for playback · last seen ${formatParallaxLastSeen(lastSeen)}`

  // Plain-language readout of the applied compensation. advanceMs > 0 pulls this speaker's audio
  // forward (it plays earlier, fixing a speaker that sounded late); < 0 holds it back.
  const trimReadout = effectiveAdvanceMs === 0
    ? 'On time'
    : `${effectiveAdvanceMs > 0 ? '+' : '-'}${Math.abs(effectiveAdvanceMs)} ms ${effectiveAdvanceMs > 0 ? 'earlier' : 'later'}`

  const flushTrimWrites = async () => {
    if (!outputDeviceId || trimWriteInFlightRef.current) return
    trimWriteInFlightRef.current = true
    let failed = false
    try {
      while (lastSubmittedAdvanceRef.current !== desiredAdvanceRef.current) {
        const next = desiredAdvanceRef.current
        const ok = await setSinkTrim(sink.id, outputDeviceId, outputDeviceLabel, next)
        if (!ok) {
          failed = true
          desiredAdvanceRef.current = persistedAdvanceRef.current
          lastSubmittedAdvanceRef.current = persistedAdvanceRef.current
          setOptimisticAdvanceMs(null)
          notify('Could not update speaker timing.')
          break
        }
        lastSubmittedAdvanceRef.current = next
      }
    } finally {
      trimWriteInFlightRef.current = false
      if (!failed && persistedAdvanceRef.current === desiredAdvanceRef.current) {
        setOptimisticAdvanceMs(null)
      }
    }
  }

  const queueTrimValue = (next: number) => {
    if (!outputDeviceId) return
    const clamped = clampParallaxTrimMs(next)
    if (clamped === desiredAdvanceRef.current) return
    desiredAdvanceRef.current = clamped
    setOptimisticAdvanceMs(clamped)
    void flushTrimWrites()
  }

  const handleTrimAdjust = (deltaMs: number) => {
    queueTrimValue(stepParallaxTrimMs(desiredAdvanceRef.current, deltaMs))
  }

  const handleTrimReset = () => {
    queueTrimValue(0)
  }

  const startRename = () => {
    setMenuOpen(false)
    setRenameInput(sink.name)
    setRenaming(true)
  }

  const saveRename = () => {
    const nextName = renameInput.trim()
    if (!nextName) {
      notify('Speaker name is required.')
      return
    }
    void renamePairedSink(sink.id, nextName).then((renamed) => {
      if (!renamed) {
        notify('Could not rename speaker.')
        return
      }
      notify('Renamed speaker.')
      setRenaming(false)
    }).catch((error: unknown) => {
      notify(error instanceof Error ? error.message : 'Failed to rename speaker.')
    })
  }

  const handleClearCache = () => {
    setMenuOpen(false)
    void clearHostPresenceCache(sink.id).then((status) => {
      if (status) notify('Cleared cached status.')
    }).catch((error: unknown) => {
      notify(error instanceof Error ? error.message : 'Failed to clear cached status.')
    })
  }

  const handleRevoke = () => {
    setMenuOpen(false)
    if (!window.confirm(`Remove "${sink.name}"? It will need to be paired again to reconnect.`)) return
    void revokePairedSink(sink.id)
  }

  return (
    <div className={`parallax-speaker-row ${online ? 'is-online' : 'is-offline'} ${playbackEnabled ? 'is-playback-active' : 'is-playback-inactive'}`}>
      <div className="parallax-speaker-row-head">
        <span className={`parallax-sink-status-dot ${online ? 'is-online' : 'is-offline'}`} />
        <div className="parallax-speaker-row-identity">
          {renaming ? (
            <input
              className="settings-select parallax-sink-rename-input"
              value={renameInput}
              autoFocus
              onChange={(event) => setRenameInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveRename()
                if (event.key === 'Escape') setRenaming(false)
              }}
            />
          ) : (
            <span className="parallax-speaker-row-name">{sink.name}</span>
          )}
          <span className="parallax-speaker-row-status">{statusLine}</span>
          {canEditTrim && (
            <span className="parallax-speaker-row-substatus">
              {`Output ${outputDeviceLabel ?? outputDeviceId} · Trim ${formatParallaxTrimMs(effectiveAdvanceMs)}`}
              {echoMismatch && typeof sinkAppliedAdvanceMs === 'number'
                ? connected?.trimSyncState === 'failed'
                  ? ` (not applied; speaker reports ${formatParallaxTrimMs(sinkAppliedAdvanceMs)})`
                  : ` (applying ${formatParallaxTrimMs(sinkAppliedAdvanceMs)}…)`
                : ''}
            </span>
          )}
        </div>

        <div className="parallax-speaker-row-actions">
          {renaming ? (
            <>
              <button className="settings-btn settings-btn-primary" onClick={saveRename}>Save</button>
              <button className="settings-btn" onClick={() => setRenaming(false)}>Cancel</button>
            </>
          ) : (
            <>
              <button
                className={`settings-toggle parallax-zone-play-toggle ${playbackEnabled ? 'active' : ''}`}
                aria-pressed={playbackEnabled}
                aria-label={`${playbackEnabled ? 'Disable' : 'Enable'} playback in ${sink.name}`}
                title="Play in this zone"
                onClick={() => {
                  void setSinkPlaybackEnabled(sink.id, !playbackEnabled).catch((error: unknown) => {
                    notify(error instanceof Error ? error.message : 'Failed to update zone playback.')
                  })
                }}
              >
                {playbackEnabled ? 'Playing' : 'Play here'}
              </button>
              {online && (
                <button
                  className={`settings-btn ${tuneOpen ? 'settings-btn-primary' : ''}`}
                  onClick={() => setTuneOpen((open) => !open)}
                  title="Test and adjust this speaker's timing"
                >
                  Tune
                </button>
              )}
              <div className="parallax-row-menu-wrap">
                <button
                  className="settings-btn parallax-row-menu-btn"
                  onClick={() => setMenuOpen((open) => !open)}
                  aria-label="More actions"
                  title="More actions"
                >
                  ⋯
                </button>
                {menuOpen && (
                  <>
                    <button className="parallax-row-menu-backdrop" onClick={() => setMenuOpen(false)} aria-hidden />
                    <div className="parallax-row-menu" role="menu">
                      <button className="parallax-row-menu-item" onClick={startRename}>Rename</button>
                      <button
                        className="parallax-row-menu-item"
                        onClick={handleClearCache}
                        disabled={!connected}
                      >
                        Clear cached status
                      </button>
                      <button className="parallax-row-menu-item is-danger" onClick={handleRevoke}>Remove speaker</button>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {tuneOpen && online && (
        <div className="parallax-speaker-row-tune">
          <span className="parallax-tune-label">Timing</span>
          <button
            className={`settings-btn parallax-tune-test ${testingThis ? 'settings-btn-primary' : ''}`}
            disabled={isPlaying}
            onClick={() => {
              if (testingThis) {
                void stopTestTone()
              } else {
                void startTestTone(sink.id)
              }
            }}
            title={isPlaying
              ? 'Stop playback to use the test tone'
              : 'Play a synced metronome on this speaker (and the host, as a reference) so you can hear the offset'}
          >
            {testingThis ? 'Stop test' : 'Test sound'}
          </button>
          {synchronizing ? (
            <div className="parallax-tune-pending">
              Synchronizing this speaker… <span className="parallax-tune-countdown">{formatSecondsCentis(syncRemainingMs)}</span>
            </div>
          ) : canEditTrim ? (
            <>
              <div className="parallax-tune-control">
                <span className="parallax-tune-side-label">Sounds early?</span>
                <div className="parallax-tune-nudges">
                  <button className="settings-btn" onClick={() => handleTrimAdjust(-5)} title="Nudge 5 ms later">-5</button>
                  <button className="settings-btn" onClick={() => handleTrimAdjust(-1)} title="Nudge 1 ms later">-1</button>
                </div>
                <span className="parallax-tune-value">{trimReadout}</span>
                <div className="parallax-tune-nudges">
                  <button className="settings-btn" onClick={() => handleTrimAdjust(1)} title="Nudge 1 ms earlier">+1</button>
                  <button className="settings-btn" onClick={() => handleTrimAdjust(5)} title="Nudge 5 ms earlier">+5</button>
                </div>
                <span className="parallax-tune-side-label">Sounds late?</span>
              </div>
              <div className="parallax-tune-footer">
                <span className="parallax-tune-hint">
                  {testingThis
                    ? 'Metronome playing on this speaker and the host. Nudge until they line up.'
                    : 'Play audio or Test sound, then nudge until this speaker lines up with the others.'}
                </span>
                {effectiveAdvanceMs !== 0 && (
                  <button className="settings-btn parallax-tune-reset" onClick={handleTrimReset}>Reset</button>
                )}
              </div>
            </>
          ) : (
            <div className="parallax-tune-pending">
              {testingThis
                ? 'Listening for this speaker… the timing nudges appear once it reports its output.'
                : 'Hit Test sound (or start playback) and the timing nudges appear once this speaker reports its output.'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
