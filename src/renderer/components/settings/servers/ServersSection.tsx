import { useUIStore } from '../../../stores/uiStore'
import { QualityControl } from './QualityControl'
import { ServerHeader, UseServerRow } from './ServerHeader'
import { ServerList } from './ServerList'
import { PlusIcon } from './ServerParts'
import { StorageGroup } from './StorageGroup'
import { SyncRows } from './SyncRows'
import { useRemotePlaylistStatuses, useServers, useServerStoreErrors } from './useServers'

/**
 * Settings → Servers. Health first: one glance shows whether every server works,
 * and only problems get color and a button. One server sits right on the page;
 * two or more become a list.
 */
export default function ServersSection() {
  const servers = useServers()
  const storeErrors = useServerStoreErrors()
  const playlistStatuses = useRemotePlaylistStatuses()
  // Interim until the add-server window lands: the existing add flow lives in Library.
  const addServer = () => useUIStore.getState().setPendingSettingsSection('library')
  const addButton = (
    <button type="button" className="servers-btn" onClick={addServer}><PlusIcon />Add server</button>
  )

  return (
    <section className="settings-section settings-section-panel servers-section">
      <div className="settings-section-head servers-section-head">
        <h3>Servers</h3>
        {servers.length > 0 && addButton}
      </div>
      <div className="servers-page">
        {servers.length === 0 && (
          <div className="servers-group servers-empty">
            <span className="servers-empty-title">No servers yet</span>
            <span className="servers-sub">Stream your Plex, Jellyfin, Subsonic or Navidrome library alongside your local music.</span>
            <button type="button" className="servers-btn is-accent" onClick={addServer}><PlusIcon />Add server</button>
            <span className="servers-hint">Favorites, ratings and playlists only sync if you turn them on.</span>
          </div>
        )}
        {servers.length === 1 && (
          <div className="servers-group">
            <ServerHeader server={servers[0]} />
            <UseServerRow server={servers[0]} />
            <SyncRows server={servers[0]} playlistStatuses={playlistStatuses} />
          </div>
        )}
        {servers.length > 1 && <ServerList servers={servers} />}
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
    </section>
  )
}
