import { useEffect, useState } from 'react'
import type { NotchPrefs, NotchRestingView, NotchRuntimeState } from '../../../types/notch'
import SettingsSegmentedControl, { type SettingsSegmentedOption } from '../settings/SettingsSegmentedControl'

const RESTING_VIEW_OPTIONS: readonly SettingsSegmentedOption<NotchRestingView>[] = [
  { value: 'hidden', label: 'Hidden' },
  { value: 'metadata', label: 'Metadata' },
  { value: 'oscilloscope', label: 'Oscilloscope' },
  { value: 'spectrum', label: 'Spectrum' },
]

export default function NotchSettings() {
  const [state, setState] = useState<NotchRuntimeState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.electronAPI.notch.getState().then(value => { if (active) setState(value) })
      .catch(() => { if (active) setError('Could not load notch settings.') })
    const unsubscribe = window.electronAPI.notch.onState(setState)
    return () => { active = false; unsubscribe() }
  }, [])
  const update = async (patch: Partial<NotchPrefs>) => {
    setBusy(true); setError('')
    try { setState(await window.electronAPI.notch.setPrefs(patch)) }
    catch { setError('Could not save notch settings. Please try again.') }
    finally { setBusy(false) }
  }
  const toggle = (key: 'enabled' | 'hoverEnabled' | 'trackChangePopups' | 'showOverFullscreen', label: string) =>
    <div className="settings-field settings-field-inline">
      <span className="settings-field-label">{label}</span>
      <button className={`settings-toggle ${state?.prefs[key] ? 'active' : ''}`} role="switch" aria-checked={state?.prefs[key] ?? false} aria-label={label}
        disabled={busy || !state || (state.availability === 'unavailable' && !(key === 'enabled' && state.prefs.enabled))} onClick={() => void update({ [key]: !state?.prefs[key] })}>
        {state?.prefs[key] ? 'Enabled' : 'Disabled'}
      </button>
    </div>
  return <div className="settings-card">
    <div className="settings-card-label">Notch Integration · macOS</div>
    <p className="settings-note">Requires macOS and a MacBook with a built-in display notch. Hover beneath the notch to preview playback; click to expand.</p>
    <div className="settings-grid">
      {toggle('enabled', 'Notch Integration')}
      {state?.prefs.enabled && <>
        <div className="settings-field"><span className="settings-field-label">Resting view</span>
          <SettingsSegmentedControl
            ariaLabel="Notch resting view"
            fullWidth
            disabled={busy}
            options={RESTING_VIEW_OPTIONS}
            value={state.prefs.restingView}
            onChange={restingView => void update({ restingView })}
          />
        </div>
        {toggle('hoverEnabled', 'Reveal on hover')}
        {toggle('trackChangePopups', 'Track-change popups')}
        {toggle('showOverFullscreen', 'Show over fullscreen apps')}
      </>}
    </div>
    <p className="settings-note">Automatic views and track popups stay hidden while Astra’s main window is in front.</p>
    {state?.availability === 'no-notch' && <p className="settings-note">No built-in display with a notch detected. On a supported MacBook, your preferences will apply when its display is available again.</p>}
    {(error || state?.error) && <p className="settings-note settings-note-error" role="status">{error || state?.error}</p>}
  </div>
}
