import { useEffect, useRef, useState } from 'react'
import type { PlexLibraryChoice, PlexSignInStatus, PlexSource } from '../../../types/plex'
import { usePlexSettingsStore } from '../../stores/plexSettingsStore'
import StreamingQualitySettings from './StreamingQualitySettings'
import ProviderSyncControls from './ProviderSyncControls'
import RemotePlaylistControls from './RemotePlaylistControls'

export default function PlexServersPanel() {
  const { sources, status, refresh, error: storeError } = usePlexSettingsStore()
  const [signIn, setSignIn] = useState<PlexSignInStatus | null>(null)
  const [reconnect, setReconnect] = useState<PlexSource | null>(null)
  const [serverId, setServerId] = useState('')
  const [libraryId, setLibraryId] = useState('')
  const [libraries, setLibraries] = useState<PlexLibraryChoice[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<number | null>(null)
  const active = useRef(true)
  const generation = useRef(0)
  const sessionId = useRef<string | null>(null)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      generation.current++
      if (sessionId.current) void window.electronAPI.plex.cancelSignIn(sessionId.current)
    }
  }, [])
  const cancel = () => {
    generation.current++
    if (sessionId.current) void window.electronAPI.plex.cancelSignIn(sessionId.current)
    sessionId.current = null
    setSignIn(null); setReconnect(null); setServerId(''); setLibraryId(''); setLibraries([]); setBusy(false)
  }
  const begin = async (source?: PlexSource) => {
    cancel(); setReconnect(source ?? null); setBusy(true); setError('')
    const request = generation.current
    try {
      const value = await window.electronAPI.plex.beginSignIn()
      if (!active.current || request !== generation.current) { void window.electronAPI.plex.cancelSignIn(value.id); return }
      sessionId.current = value.id; setSignIn(value)
    } catch (error) { if (active.current && request === generation.current) setError(String(error instanceof Error ? error.message : error)) }
    finally { if (active.current && request === generation.current) setBusy(false) }
  }
  useEffect(() => {
    if (signIn?.state !== 'waiting') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const value = await window.electronAPI.plex.pollSignIn(signIn.id)
        if (cancelled) return
        setSignIn(value)
        if (value.state === 'waiting') timer = setTimeout(poll, 1500)
      } catch (error) {
        if (!cancelled) { setError(error instanceof Error ? error.message : 'Plex sign-in failed.'); cancel() }
      }
    }
    timer = setTimeout(poll, 1500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [signIn?.id, signIn?.state])
  const chooseServer = async (id: string) => {
    setServerId(id); setLibraryId(''); setLibraries([]); setError('')
    if (!signIn || !id) return
    const request = ++generation.current
    setBusy(true)
    try {
      const choices = await window.electronAPI.plex.libraries(signIn.id, id)
      if (active.current && request === generation.current) {
        setLibraries(choices)
        if (choices.length === 1) setLibraryId(choices[0].id)
      }
    } catch (error) { if (active.current && request === generation.current) setError(error instanceof Error ? error.message : 'Could not load music libraries.') }
    finally { if (active.current && request === generation.current) setBusy(false) }
  }
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await action(); await refresh() }
    catch (error) { if (active.current) setError(error instanceof Error ? error.message : 'Could not update Plex.') }
    finally { if (active.current) setBusy(false) }
  }
  const connect = () => {
    if (!signIn || !serverId || !libraryId) return
    void run(async () => {
      const source = await window.electronAPI.plex.connect({ signInId: signIn.id, serverId, libraryId,
        ...(reconnect ? { sourceId: reconnect.id, name: reconnect.name } : {}) })
      sessionId.current = null; setSignIn(null); setReconnect(null)
      await refresh()
      await window.electronAPI.plex.syncSource(source.id)
    })
  }
  return <section className="settings-card">
    <h4 className="settings-card-label">Plex</h4>
    {sources.map(source => {
      const state = status?.sources.find(item => item.sourceId === source.id)
      const syncing = state?.status === 'syncing'
      const playlistSources = sources.filter(peer => peer.account_id === source.account_id && peer.server_id === source.server_id)
        .sort((a, b) => a.id - b.id)
      return <div key={source.id} className="remote-source-card">
        <div className="remote-source-card-header">
          <span className="remote-source-card-header-title">{source.name}</span>
          <span className="settings-chip settings-chip-mono">Plex</span>
        </div>
        <p className="remote-source-card-meta">{source.username} · {source.library_name}{source.enabled !== 1 ? ' · Disabled' : ''}</p>
        {state?.progress && <p className="remote-source-card-progress" role="status">{state.progress.activity}{state.progress.total !== null ? ` (${state.progress.current ?? 0}/${state.progress.total})` : ''}</p>}
        {state?.error && <p className="settings-note settings-note-error">{state.error}</p>}
        <ProviderSyncControls provider="plex" sourceId={source.id} connected={source.enabled === 1} />
        {playlistSources[0].id === source.id && <RemotePlaylistControls provider="plex" sourceId={source.id}
          connected={playlistSources.some(peer => peer.enabled === 1)} />}
        <StreamingQualitySettings source={{ provider: 'plex', sourceId: source.id }} />
        {deleting === source.id ? <div className="remote-delete-confirm">
          <p>Remove this connection and keep its tracks as unavailable placeholders, or purge its tracks?</p>
          <div className="remote-delete-confirm-actions">
            <button className="settings-btn" disabled={busy} onClick={() => void run(async () => { await window.electronAPI.plex.deleteSource(source.id, false); setDeleting(null) })}>Keep Tracks</button>
            <button className="settings-btn settings-btn-danger" disabled={busy} onClick={() => void run(async () => { await window.electronAPI.plex.deleteSource(source.id, true); setDeleting(null) })}>Purge Tracks</button>
            <button className="settings-btn" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button>
          </div>
        </div> : <div className="remote-source-card-footer">
          <button className="settings-btn" disabled={busy || syncing || source.enabled !== 1} onClick={() => void run(() => window.electronAPI.plex.syncSource(source.id))}>{syncing ? 'Syncing…' : 'Sync'}</button>
          <button className="settings-btn" disabled={busy || !!signIn} onClick={() => void begin(source)}>Reconnect</button>
          <button className="settings-btn" disabled={busy} onClick={() => void run(async () => {
            await window.electronAPI.plex.updateSource(source.id, { enabled: source.enabled !== 1 })
            if (source.enabled !== 1) await window.electronAPI.plex.syncSource(source.id)
          })}>{source.enabled === 1 ? 'Disable' : 'Enable'}</button>
          <button className="settings-btn" disabled={busy} onClick={() => setDeleting(source.id)}>Delete</button>
        </div>}
      </div>
    })}
    {!signIn ? <>
      <p className="settings-note">Sign in with your Plex account, then choose a server and Music library.</p>
      <button className="settings-btn settings-btn-primary" disabled={busy} onClick={() => void begin()}>{busy ? 'Connecting…' : 'Sign in with Plex'}</button>
    </> : <div className="remote-source-card">
      {signIn.state === 'waiting' ? <p role="status">Finish signing in to Plex in your browser. Astra will continue here automatically.</p> : <>
        <p>Signed in as {signIn.username}.{reconnect ? ` Select the same server and library to reconnect ${reconnect.name}.` : ''}</p>
        {!signIn.servers?.length && <p className="settings-note">No Plex servers are available to this account.</p>}
        <label className="settings-field"><span className="settings-field-label">Server</span>
          <select className="settings-select" value={serverId} disabled={busy} onChange={event => void chooseServer(event.target.value)}>
            <option value="">Select a server</option>
            {signIn.servers?.map(server => <option key={server.id} value={server.id}>{server.name}{server.owned ? '' : ' (shared)'}</option>)}
          </select>
        </label>
        {serverId && !busy && !libraries.length && <p className="settings-note">No Music libraries are available on this server.</p>}
        {libraries.length > 0 && <label className="settings-field"><span className="settings-field-label">Music library</span>
          <select className="settings-select" value={libraryId} disabled={busy} onChange={event => setLibraryId(event.target.value)}>
            <option value="">Select a library</option>
            {libraries.map(library => <option key={library.id} value={library.id}>{library.name}</option>)}
          </select>
        </label>}
        <button className="settings-btn settings-btn-primary" disabled={busy || !libraryId} onClick={connect}>{busy ? 'Connecting…' : 'Connect library'}</button>
      </>}
      <button className="settings-btn" disabled={busy} onClick={cancel}>Cancel</button>
    </div>}
    {(error || storeError) && <p className="settings-note settings-note-error" role="alert">{error || storeError}</p>}
  </section>
}
