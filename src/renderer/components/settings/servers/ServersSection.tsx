import { useEffect, useRef, useState } from 'react'
import { useUIStore } from '../../../stores/uiStore'
import { QualityControl } from './QualityControl'
import { ServerHeader, UseServerRow } from './ServerHeader'
import { ServerList } from './ServerList'
import type { ServerMenuAction } from './ServerMenu'
import { ServerPage } from './ServerPage'
import { PlusIcon } from './ServerParts'
import { StorageGroup } from './StorageGroup'
import { SyncRows } from './SyncRows'
import { useRemotePlaylistStatuses, useServers, useServerStoreErrors } from './useServers'

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

  // Interim until the windows land: adding, changing and removing servers still
  // happen in the old panel under Library.
  const openLegacyPanel = () => useUIStore.getState().setPendingSettingsSection('library')
  const onMenuAction = (_action: ServerMenuAction) => openLegacyPanel()

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
    <button type="button" className="servers-btn" onClick={openLegacyPanel}><PlusIcon />Add server</button>
  )

  return (
    <section className="settings-section settings-section-panel servers-section">
      <div className="settings-section-head servers-section-head">
        <h3>Servers</h3>
        {servers.length > 0 && !opened && addButton}
      </div>
      <div className="servers-page" ref={pageRef}>
        {opened ? (
          <ServerPage key={opened.key} server={opened} servers={servers} playlistStatuses={playlistStatuses}
            errors={storeErrors} onMenuAction={onMenuAction}
            onBack={() => { returnKey.current = opened.key; setNavigated(true); setOpenKey(null) }} />
        ) : (
          <div className={`servers-pane${navigated ? ' is-entering' : ''}`}>
            {servers.length === 0 && (
              <div className="servers-group servers-empty">
                <span className="servers-empty-title">No servers yet</span>
                <span className="servers-sub">Stream your Plex, Jellyfin, Subsonic or Navidrome library alongside your local music.</span>
                <button type="button" className="servers-btn is-accent" onClick={openLegacyPanel}><PlusIcon />Add server</button>
                <span className="servers-hint">Favorites, ratings and playlists only sync if you turn them on.</span>
              </div>
            )}
            {servers.length === 1 && (
              <div className="servers-group">
                <ServerHeader server={servers[0]} onMenuAction={onMenuAction} />
                <UseServerRow server={servers[0]} />
                <SyncRows server={servers[0]} playlistStatuses={playlistStatuses} />
              </div>
            )}
            {servers.length > 1 && <ServerList servers={servers} onOpen={key => { setNavigated(true); setOpenKey(key) }} />}
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
    </section>
  )
}
