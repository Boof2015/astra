import { useCallback, useEffect, useRef, useState } from 'react'
import type { PhoneRemotePairedDevice, PhoneRemoteStatus } from '../../../types/phoneRemote'
import { companionModelName } from '../../../shared/companionDevices'
import HardwareIllustration, { ConnectionIllustration } from '../devices/HardwareIllustration'
import '../devices/devices.css'

function Chevron({ back = false }: { back?: boolean }) {
  return <svg className="hardware-chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={back ? 'm15 5-7 7 7 7' : 'm9 5 7 7-7 7'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
}
function Status({ device, enabled }: { device: PhoneRemotePairedDevice; enabled: boolean }) {
  return <span className="hardware-status" data-connected={enabled && device.connected}><span className="hardware-status-dot"/>{!enabled ? 'Connections paused' : device.connected ? 'Connected' : 'Offline'}</span>
}

export default function HardwareCompanionsPanel() {
  const [status, setStatus] = useState<PhoneRemoteStatus | null>(null)
  const [devices, setDevices] = useState<PhoneRemotePairedDevice[]>([])
  const [view, setView] = useState('list')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [confirmForget, setConfirmForget] = useState(false)
  const [saved, setSaved] = useState(false)
  const generation = useRef(0)
  const existingIds = useRef<Set<string> | null>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const backButton = useRef<HTMLButtonElement>(null)
  const enabled = Boolean(status?.hardwareEnabled)
  const selected = devices.find(device => device.id === view)

  const refresh = useCallback(async () => {
    const current = ++generation.current
    try {
      const [nextStatus, nextDevices] = await Promise.all([window.electronAPI.devices.getStatus(), window.electronAPI.devices.list()])
      if (current !== generation.current) return
      setStatus(nextStatus); setDevices(nextDevices); setLoading(false)
      const added = existingIds.current && nextDevices.find(device => !existingIds.current!.has(device.id))
      if (added) setView(old => old === 'add' ? added.id : old)
      existingIds.current = new Set(nextDevices.map(device => device.id))
    } catch (cause) {
      if (current === generation.current) { setError(cause instanceof Error ? cause.message : 'Could not load devices.'); setLoading(false) }
    }
  }, [])
  useEffect(() => {
    const unsubscribe = window.electronAPI.devices.onStatus(() => { void refresh() })
    void refresh()
    return () => { generation.current++; unsubscribe() }
  }, [refresh])
  useEffect(() => { setName(selected?.name ?? '') }, [selected?.id, selected?.name])
  useEffect(() => { setConfirmForget(false); setSaved(false) }, [selected?.id])
  useEffect(() => { if (view !== 'list') backButton.current?.focus() }, [view])

  async function perform(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true); setError('')
    try { await action(); await refresh(); return true }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update this device.'); return false }
    finally { setBusy(false) }
  }
  async function add() {
    if (!enabled && !await perform(() => window.electronAPI.devices.setEnabled(true))) return
    setView('add')
  }
  function back() { setView('list'); setConfirmForget(false); setError(''); requestAnimationFrame(() => addButton.current?.focus()) }
  const serviceError = enabled ? status?.lastError : null

  return <section className="settings-section settings-section-panel hardware-devices" aria-label="Devices">
    <div className="hardware-section-header">
      <div><h3>Devices</h3><p>Your Astra hardware, all in one place.</p></div>
      <label className="hardware-switch-label">Device connections
        <button type="button" className="hardware-switch" role="switch" aria-label="Device connections" aria-checked={enabled} disabled={busy || loading}
          onClick={() => void perform(() => window.electronAPI.devices.setEnabled(!enabled))}><span/></button>
      </label>
    </div>
    {(error || serviceError) && <div className="hardware-error" role="alert">{error || serviceError}</div>}
    {loading ? <p className="hardware-hint" role="status">Loading your devices…</p> : <>
      {view === 'list' && devices.length === 0 && <div className="hardware-empty">
        <ConnectionIllustration/>
        <div className="hardware-empty-copy"><span className="hardware-overline">Make the connection</span><h4>Your music. Within reach.</h4><p>Connect your Astra hardware and give your music a place on your desk.</p>
          <button ref={addButton} className="hardware-button hardware-button-primary" disabled={busy} onClick={() => void add()}>Connect a device <Chevron/></button>
        </div>
      </div>}
      {view === 'list' && devices.length > 0 && <>
        <div className="hardware-toolbar"><span className="hardware-overline">Your devices</span><button ref={addButton} className="hardware-button" disabled={busy} onClick={() => void add()}><span aria-hidden="true">＋</span> Add device</button></div>
        <div className="hardware-grid">{devices.map(device => <button key={device.id} type="button" className="hardware-device-card" aria-label={`Manage ${device.name}`} onClick={() => setView(device.id)}>
          <HardwareIllustration modelId={device.deviceInfo?.modelId} connected={Boolean(device.connected && enabled)}/>
          <span className="hardware-device-card-name">{device.name}</span>
          <span className="hardware-card-footer"><Status device={device} enabled={enabled}/><Chevron/></span>
        </button>)}</div>
        {!enabled && <p className="hardware-hint">Your devices are remembered. Turn on device connections to reconnect.</p>}
      </>}
      {view === 'add' && <>
        <div className="hardware-toolbar"><button ref={backButton} className="hardware-button hardware-button-quiet" onClick={back}><Chevron back/> Back to devices</button></div>
        <div className="hardware-setup"><ConnectionIllustration/><div className="hardware-empty-copy">
          <span className="hardware-overline">Add a device</span><h4>Bring your hardware closer.</h4>
          <ol className="hardware-setup-steps"><li><span>Connect it to this computer with a <strong>USB data cable</strong>.</span></li><li><span>Open setup on your device and choose <strong>Find Astra</strong>.</span></li></ol>
          <span className="hardware-status" role="status" data-connected={Boolean(status?.hardwareActive)}><span className="hardware-status-dot"/>{!enabled ? 'Device connections are paused' : status?.hardwareActive ? 'Ready for your device' : 'Starting connections…'}</span>
          {!enabled && <button className="hardware-button" disabled={busy} onClick={() => void perform(() => window.electronAPI.devices.setEnabled(true))}>Enable connections</button>}
        </div></div>
        <p className="hardware-hint">Already paired? Plug it in and it will reconnect automatically.</p>
      </>}
      {selected && <>
        <div className="hardware-toolbar"><button ref={backButton} className="hardware-button hardware-button-quiet" onClick={back}><Chevron back/> Back to devices</button></div>
        <div className="hardware-detail-hero"><HardwareIllustration modelId={selected.deviceInfo?.modelId} connected={Boolean(enabled && selected.connected)}/><div className="hardware-detail-copy">
          <span className="hardware-overline">{companionModelName(selected.deviceInfo)}</span><h4 className="hardware-detail-title">{selected.name}</h4><Status device={selected} enabled={enabled}/>
          <p>{!enabled ? 'Turn on device connections to use your hardware.' : selected.connected ? 'Your music is within reach.' : 'Connect your device to this computer. It will reconnect automatically.'}</p>
        </div></div>
        <div className="hardware-detail-grid">
          <div className="hardware-detail-block"><h4>Make it yours</h4><form onSubmit={event => { event.preventDefault(); void perform(() => window.electronAPI.devices.rename(selected.id, name)).then(ok => { if (ok) setSaved(true) }) }}>
            <label htmlFor="hardware-device-name">Device name</label><div className="hardware-rename-row"><input id="hardware-device-name" className="hardware-name-input" value={name} maxLength={80} onChange={event => {setName(event.target.value);setSaved(false)}} disabled={busy}/><button className="hardware-button" type="submit" disabled={busy || !name.trim() || name.trim() === selected.name}>Save</button></div>
            <p className="hardware-hint" role="status">{saved ? 'Name saved.' : 'A name that feels at home on your desk.'}</p>
          </form></div>
          <div className="hardware-detail-block"><h4>About this device</h4><dl className="hardware-detail-facts"><dt>Model</dt><dd>{companionModelName(selected.deviceInfo)}</dd>
            {selected.deviceInfo?.softwareVersion && <><dt>Software</dt><dd>{selected.deviceInfo.softwareVersion}</dd></>}
            <dt>Paired</dt><dd>{new Date(selected.createdAt).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})}</dd>
          </dl></div>
        </div>
        <div className="hardware-forget-row"><p>{confirmForget ? 'You’ll need to pair again to reconnect this device.' : 'Remove this device from Astra.'}</p><div className="hardware-pair-actions">
          {confirmForget && <button className="hardware-button" disabled={busy} onClick={() => setConfirmForget(false)}>Cancel</button>}
          <button className={`hardware-button ${confirmForget ? 'hardware-button-danger' : 'hardware-button-quiet'}`} disabled={busy} onClick={() => { if (!confirmForget) setConfirmForget(true); else void perform(() => window.electronAPI.devices.forget(selected.id)).then(ok => { if(ok) back() }) }}>{confirmForget ? 'Confirm forget' : 'Forget device…'}</button>
        </div></div>
      </>}
      {view !== 'list' && view !== 'add' && !selected && <div className="hardware-empty-copy"><h4>Device no longer paired</h4><button ref={backButton} className="hardware-button" onClick={back}>Back to devices</button></div>}
    </>}
  </section>
}
