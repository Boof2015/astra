import { useEffect, useRef, type ReactNode } from 'react'
import type { RemotePlaylistStatus } from '../../../../types/remotePlaylists'
import { QualityControl } from './QualityControl'
import { LibrariesGroup } from './LibrariesGroup'
import { ServerHeader, UseServerRow } from './ServerHeader'
import type { ServerMenuAction } from './ServerMenu'
import { useServerTotals } from '../../../stores/serverCountsStore'
import { lastSyncedText, libraryCountsText } from './serverModel'
import { ChevronLeftIcon } from './ServerParts'
import { SyncRows } from './SyncRows'
import { useNow, type ServerEntry, type ServerLibrary } from './useServers'

/** Quiet key/value rows; mono only for real values like the address. */
function Details({ server }: { server: ServerEntry }) {
  const now = useNow()
  const inLibrary = libraryCountsText(server, useServerTotals(server))
  // Plex has no address to show (it picks its own); its libraries have their own group.
  const rows: [string, ReactNode][] = [
    ...(server.address ? [['Address', <span className="servers-mono">{server.address}</span>] as [string, ReactNode]] : []),
    ['Account', server.user],
    ...(inLibrary ? [['In your library', inLibrary] as [string, string]] : []),
    ['Last synced', lastSyncedText(server, now)]
  ]
  return (
    <div className="servers-group">
      {rows.map(([label, value]) => (
        <div key={label} className="servers-row servers-kv">
          <span className="servers-label">{label}</span>
          <span className="servers-kv-value">{value}</span>
        </div>
      ))}
    </div>
  )
}

/** One server's own page, opened from the list when there are several. */
export function ServerPage({ server, servers, playlistStatuses, errors, onBack, onMenuAction, onAddLibrary, onRemoveLibrary }: {
  server: ServerEntry
  servers: ServerEntry[]
  playlistStatuses: RemotePlaylistStatus[]
  errors: string[]
  onBack: () => void
  onMenuAction: (action: ServerMenuAction) => void
  onAddLibrary: () => void
  onRemoveLibrary: (library: ServerLibrary) => void
}) {
  const backRef = useRef<HTMLButtonElement>(null)
  // Move focus into the page, which also brings it into view.
  useEffect(() => { backRef.current?.focus() }, [server.key])
  return (
    <div className="servers-pane is-entering">
      <button ref={backRef} type="button" className="servers-back" onClick={onBack}><ChevronLeftIcon />Servers</button>
      <div className="servers-group">
        <ServerHeader server={server} onMenuAction={onMenuAction} />
        <UseServerRow server={server} />
      </div>
      {errors.map(message => <p key={message} className="servers-error" role="alert">{message}</p>)}
      {server.provider === 'plex' && <LibrariesGroup server={server} onAdd={onAddLibrary} onRemove={onRemoveLibrary} />}
      <section className="servers-subsection" aria-label="Sync">
        <h4>Sync</h4>
        <div className="servers-group"><SyncRows server={server} playlistStatuses={playlistStatuses} /></div>
      </section>
      <section className="servers-subsection" aria-label="Streaming">
        <h4>Streaming</h4>
        <div className="servers-group"><QualityControl server={server} servers={servers} /></div>
      </section>
      <section className="servers-subsection" aria-label="Details">
        <h4>Details</h4>
        <Details server={server} />
      </section>
    </div>
  )
}
