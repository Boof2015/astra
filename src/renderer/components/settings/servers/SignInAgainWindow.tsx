import { useEffect, useState } from 'react'
import type { PresencePhase } from '../../../hooks/usePresence'
import { usePlexSettingsStore } from '../../../stores/plexSettingsStore'
import { cleanIpcError } from './serverModel'
import { AlertIcon, CheckIcon, ExternalIcon } from './ServerParts'
import { ServerWindow, Spinner } from './ServerWindow'
import { syncServer, type ServerEntry } from './useServers'
import { usePlexSignIn } from './usePlexSignIn'

/**
 * Plex "Sign in again": the browser sign-in, then a summary, then Reconnect. The
 * server and library aren't picked again; the new sign-in has to reach the same ones.
 */
export function SignInAgainWindow({ phase, server, onClose }: {
  phase: PresencePhase
  server: ServerEntry
  onClose: () => void
}) {
  const plex = usePlexSignIn()
  const source = usePlexSettingsStore(state => state.sources.find(item => item.id === server.id))
  const [reconnecting, setReconnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Start on open. A timer rather than a direct call, so React's development
  // double-mount cancels the first one instead of opening two browser tabs.
  useEffect(() => {
    const timer = window.setTimeout(() => { void plex.begin() }, 0)
    return () => window.clearTimeout(timer)
  }, [plex.begin])

  const ready = plex.status?.state === 'ready'
  const plexServer = ready && source ? plex.status?.servers?.find(item => item.id === source.server_id) : undefined

  // Connecting needs the server reached through this sign-in, and the saved library
  // confirmed on it, before Reconnect: the main process only reconnects a library this
  // session has loaded. Results from an earlier sign-in attempt are ignored.
  const [check, setCheck] = useState<{ signInId: string; state: 'checking' | 'ok' | 'missing' | 'failed'; message?: string } | null>(null)
  const signInId = plex.status?.id
  useEffect(() => {
    if (!signInId || !plexServer || !source) return
    let current = true
    setCheck({ signInId, state: 'checking' })
    window.electronAPI.plex.libraries(signInId, source.server_id)
      .then(libraries => {
        if (current) setCheck({ signInId, state: libraries.some(item => item.id === source.library_id) ? 'ok' : 'missing' })
      })
      .catch(failure => {
        if (current) setCheck({ signInId, state: 'failed', message: cleanIpcError(failure, `Couldn’t reach ${plexServer.name}.`) })
      })
    return () => { current = false }
  }, [signInId, plexServer?.id, source?.server_id, source?.library_id])
  const verified = plexServer && check && check.signInId === signInId ? check.state : null

  const reconnect = async () => {
    if (!plex.status || !source || reconnecting || verified !== 'ok') return
    setReconnecting(true)
    setError(null)
    try {
      await window.electronAPI.plex.connect({
        signInId: plex.status.id, serverId: source.server_id, libraryId: source.library_id, sourceId: source.id, name: source.name
      })
      plex.release()
      await usePlexSettingsStore.getState().refresh()
      onClose()
      void syncServer(server)
    } catch (failure) {
      setError(cleanIpcError(failure, 'Couldn’t reconnect this server.'))
      setReconnecting(false)
    }
  }

  let body
  if (plex.error) {
    body = <div className="servers-window-error" role="alert"><AlertIcon /><div>{plex.error}</div></div>
  } else if (!ready) {
    body = (
      <div className="servers-wait" role="status">
        <Spinner />
        <div>
          <strong>Finish signing in to Plex in your browser.</strong>
          <p className="servers-hint">Astra continues here automatically once you approve.</p>
          <button type="button" className="servers-btn is-small" disabled={plex.starting} onClick={() => void plex.begin()}>
            <ExternalIcon />Open browser again
          </button>
        </div>
      </div>
    )
  } else if (!plexServer) {
    body = (
      <div className="servers-window-error" role="alert">
        <AlertIcon />
        <div>
          <strong>Signed in to Plex as {plex.status?.username ?? 'this account'}, but it can’t see {server.name}’s server.</strong>{' '}
          Sign in with the Plex account that added it.
        </div>
      </div>
    )
  } else if (verified !== 'ok' && verified !== 'missing' && verified !== 'failed') {
    body = (
      <div className="servers-wait" role="status">
        <Spinner />
        <div><strong>Checking {plexServer.name}…</strong></div>
      </div>
    )
  } else if (verified === 'missing' || verified === 'failed') {
    body = (
      <div className="servers-window-error" role="alert">
        <AlertIcon />
        <div>
          {verified === 'missing'
            ? <><strong>{source?.library_name ?? 'This library'} is no longer on {plexServer.name}.</strong> Remove this server, then add the library you want.</>
            : check?.message}
        </div>
      </div>
    )
  } else {
    body = (
      <>
        <div className="servers-ok-line"><CheckIcon />Signed in to Plex as {plex.status?.username ?? 'you'}</div>
        <div className="servers-window-rows">
          <div className="servers-row servers-kv"><span className="servers-label">Server</span><span className="servers-kv-value">{plexServer.name}</span></div>
          <div className="servers-row servers-kv"><span className="servers-label">Library</span><span className="servers-kv-value">{source?.library_name}</span></div>
        </div>
        <p className="servers-hint">{server.name} reconnects with this sign-in. Your settings are kept.</p>
        {error && <div className="servers-window-error" role="alert"><AlertIcon /><div>{error}</div></div>}
      </>
    )
  }

  const retry = plex.error || (ready && !plexServer) || verified === 'failed'
  return (
    <ServerWindow phase={phase} title="Sign in to Plex again" subtitle={server.name} busy={reconnecting} onClose={onClose}
      footer={<>
        <button type="button" className="servers-btn" disabled={reconnecting} onClick={onClose}>Cancel</button>
        {retry && <button type="button" className="servers-btn is-accent" onClick={() => void plex.begin()}>Sign in again</button>}
        {verified === 'ok' && (
          <button type="button" className="servers-btn is-accent" disabled={reconnecting} onClick={() => void reconnect()}>
            {reconnecting ? <><Spinner />Reconnecting…</> : 'Reconnect'}
          </button>
        )}
      </>}>
      {body}
    </ServerWindow>
  )
}
