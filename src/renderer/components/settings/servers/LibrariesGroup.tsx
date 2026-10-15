import { serverCounts, useServerCountsStore } from '../../../stores/serverCountsStore'
import { plural } from './serverModel'
import { PlusIcon } from './ServerParts'
import type { ServerEntry, ServerLibrary } from './useServers'

/** What one library is doing: its problem or sync when there is one, its track count otherwise. */
function LibraryRow({ server, library, onRemove }: { server: ServerEntry; library: ServerLibrary; onRemove?: () => void }) {
  const counts = useServerCountsStore(state => serverCounts(state, library.key))
  let line: string | null = null
  let warn = false
  if (library.state === 'failed') {
    warn = true
    line = library.problem === 'offline' ? 'Offline' : library.problem === 'signed-out' ? 'Sign-in expired' : 'Sync failed'
  } else if (library.state === 'syncing') line = 'Syncing…'
  else if (library.state === 'checking') line = 'Checking…'
  else if (counts && (counts.tracks > 0 || library.lastSyncAt !== null)) line = counts.tracks ? plural(counts.tracks, 'track') : 'No tracks'
  return (
    <div className={`servers-row${server.enabled ? '' : ' is-paused'}`}>
      <div className="servers-row-text">
        <span className="servers-label">{library.name}</span>
        {line && <span className={`servers-sub${warn ? ' is-warn' : ''}`}>{line}</span>}
      </div>
      {onRemove && <button type="button" className="servers-btn is-small" onClick={onRemove}>Remove</button>}
    </div>
  )
}

/**
 * A Plex server's music libraries. Each can be removed while there's more than one (the
 * last goes with the server itself), and more can be added from the same server.
 */
export function LibrariesGroup({ server, onAdd, onRemove }: {
  server: ServerEntry
  onAdd: () => void
  onRemove: (library: ServerLibrary) => void
}) {
  return (
    <section className="servers-subsection" aria-label="Libraries">
      <h4>Libraries</h4>
      <div className="servers-group">
        {server.libraries.map(library => (
          <LibraryRow key={library.key} server={server} library={library}
            onRemove={server.libraries.length > 1 ? () => onRemove(library) : undefined} />
        ))}
        <div className="servers-row">
          <button type="button" className="servers-link servers-add-library" disabled={!server.enabled} onClick={onAdd}>
            <PlusIcon />Add library
          </button>
        </div>
      </div>
    </section>
  )
}
