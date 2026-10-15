import { useEffect, useRef, useState } from 'react'
import { usePresence } from '../../../hooks/usePresence'
import { useServerCountsStore } from '../../../stores/serverCountsStore'
import { useServerWindowRequest } from '../../../stores/serverWindowRequest'
import { AddServerWindow } from './AddServerWindow'
import { ChangeConnectionWindow } from './ChangeConnectionWindow'
import { QualityControl } from './QualityControl'
import { RemoveServerWindow } from './RemoveServerWindow'
import { ServerHeader, UseServerRow } from './ServerHeader'
import { ServerList } from './ServerList'
import type { ServerMenuAction } from './ServerMenu'
import { ServerPage } from './ServerPage'
import { PlusIcon } from './ServerParts'
import { StorageGroup } from './StorageGroup'
import { SignInAgainWindow } from './SignInAgainWindow'
import { SyncRows } from './SyncRows'
import { useRemotePlaylistStatuses, useServers, useServerStoreErrors, type ServerEntry } from './useServers'

/** The focused windows. Each keeps the server as it was when opened, so it can finish closing after a removal. */
type WindowState =
  | { kind: 'add' }
  | { kind: 'connection' | 'sign-in' | 'remove'; server: ServerEntry }

/**
 * Settings → Servers. Health first: one glance shows whether every server works,
 * and only problems get color and a button. One server sits right on the page;
 * two or more become a list, and each opens its own page.
 */
export default function ServersSection() {
  const servers = useServers()
  const storeErrors = useServerStoreErrors()
  const playlistStatuses = useRemotePlaylistStatuses()
  const [openKey, setOpenKey] = useState<string | null>(null)
  // Panes slide in when you move between them, not when Settings first opens.
  const [navigated, setNavigated] = useState(false)
  const returnKey = useRef<string | null>(null)
  const pageRef = useRef<HTMLDivElement>(null)

  const [windowState, setWindowState] = useState<WindowState | null>(null)
  const windowPresence = usePresence(windowState)
  const closeWindow = () => setWindowState(null)
  const openAdd = () => setWindowState({ kind: 'add' })
  const onMenuAction = (server: ServerEntry) => (action: ServerMenuAction) => setWindowState(action === 'remove'
    ? { kind: 'remove', server }
    : { kind: server.provider === 'plex' ? 'sign-in' : 'connection', server })

  // A corner cue's "Sign in" asks for a server's sign-in window; open it once that server is known.
  const reconnectRequest = useServerWindowRequest(state => state.reconnect)
  useEffect(() => {
    if (!reconnectRequest) return
    const server = servers.find(item => item.key === reconnectRequest)
    if (!server) return
    useServerWindowRequest.getState().take()
    onMenuAction(server)('connection')
  }, [reconnectRequest, servers])

  // Each server's track and album counts: read on opening, then again when they can have
  // changed: a sync finished (a failed one changes nothing), a server was turned on or off,
  // or one was added or removed.
  const countsKey = servers.map(server => [server.key, server.enabled, server.lastSyncAt].join(':')).join('|')
  useEffect(() => { void useServerCountsStore.getState().refresh() }, [countsKey])

  // A newly added server's row lights up briefly as it appears.
  const [justAdded, setJustAdded] = useState<string | null>(null)
  useEffect(() => {
    if (!justAdded) return
    const timer = window.setTimeout(() => setJustAdded(null), 1600)
    return () => window.clearTimeout(timer)
  }, [justAdded])

  // A server's page only exists while there are several; one left (or a removed
  // server) means the overview.
  const opened = servers.length > 1 ? servers.find(server => server.key === openKey) : undefined
  useEffect(() => { if (openKey && !opened) setOpenKey(null) }, [openKey, opened])

  // Back to the list puts focus on the row you came from.
  useEffect(() => {
    if (openKey || !returnKey.current) return
    const key = returnKey.current
    returnKey.current = null
    pageRef.current?.querySelector<HTMLButtonElement>(`[data-server-key="${CSS.escape(key)}"]`)?.focus()
  }, [openKey])

  const addButton = (
    <button type="button" className="servers-btn" onClick={openAdd}><PlusIcon />Add server</button>
  )
  const shown = windowPresence.shouldRender ? windowPresence.presentValue : null
  const phase = windowPresence.phase

  return (
    <section className="settings-section settings-section-panel servers-section">
      <div className="settings-section-head servers-section-head">
        <h3>Servers</h3>
        {servers.length > 0 && !opened && addButton}
      </div>
      <div className="servers-page" ref={pageRef}>
        {opened ? (
          <ServerPage key={opened.key} server={opened} servers={servers} playlistStatuses={playlistStatuses}
            errors={storeErrors} onMenuAction={onMenuAction(opened)}
            onBack={() => { returnKey.current = opened.key; setNavigated(true); setOpenKey(null) }} />
        ) : (
          <div className={`servers-pane${navigated ? ' is-entering' : ''}`}>
            {servers.length === 0 && (
              <div className="servers-group servers-empty">
                <span className="servers-empty-title">No servers yet</span>
                <span className="servers-sub">Stream your Plex, Jellyfin, Subsonic or Navidrome library alongside your local music.</span>
                <button type="button" className="servers-btn is-accent" onClick={openAdd}><PlusIcon />Add server</button>
                <span className="servers-hint">Favorites, ratings and playlists only sync if you turn them on.</span>
              </div>
            )}
            {servers.length === 1 && (
              <div className="servers-group">
                <ServerHeader server={servers[0]} showCounts onMenuAction={onMenuAction(servers[0])} />
                <UseServerRow server={servers[0]} />
                <SyncRows server={servers[0]} playlistStatuses={playlistStatuses} />
              </div>
            )}
            {servers.length > 1 && (
              <ServerList servers={servers} highlightKey={justAdded} onOpen={key => { setNavigated(true); setOpenKey(key) }}
                onReconnect={server => onMenuAction(server)('connection')} />
            )}
            {storeErrors.map(message => <p key={message} className="servers-error" role="alert">{message}</p>)}

            {servers.length > 0 && (
              <>
                <section className="servers-subsection" aria-labelledby="servers-streaming">
                  <h4 id="servers-streaming">Streaming</h4>
                  <div className="servers-group"><QualityControl servers={servers} /></div>
                </section>
                <section className="servers-subsection" aria-labelledby="servers-storage">
                  <h4 id="servers-storage">Storage</h4>
                  <StorageGroup />
                </section>
              </>
            )}
          </div>
        )}
      </div>
      {shown?.kind === 'add' && (
        <AddServerWindow phase={phase} onClose={closeWindow} onAdded={key => { closeWindow(); setJustAdded(key) }} />
      )}
      {shown?.kind === 'connection' && <ChangeConnectionWindow phase={phase} server={shown.server} onClose={closeWindow} />}
      {shown?.kind === 'sign-in' && <SignInAgainWindow phase={phase} server={shown.server} onClose={closeWindow} />}
      {shown?.kind === 'remove' && <RemoveServerWindow phase={phase} server={shown.server} onClose={closeWindow} />}
    </section>
  )
}
