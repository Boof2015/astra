import { useEffect, useState } from 'react'
import type { PresencePhase } from '../../../hooks/usePresence'
import { cleanIpcError, plural } from './serverModel'
import { AlertIcon } from './ServerParts'
import { ServerWindow, Spinner } from './ServerWindow'
import { removePlexLibrary, removeServer, type ServerEntry, type ServerLibrary } from './useServers'

/**
 * Remove a server, or with `library` just that library of a Plex server. Its tracks are
 * kept as unavailable unless you choose to delete them.
 */
export function RemoveServerWindow({ phase, server, library, onClose }: {
  phase: PresencePhase
  server: ServerEntry
  library?: ServerLibrary
  onClose: () => void
}) {
  const [deleteTracks, setDeleteTracks] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Exactly what "Delete them" deletes, read as the window opens: unlike the counts shown
  // elsewhere, it includes tracks the server no longer has. "Its tracks" until it's known.
  const [removalCount, setRemovalCount] = useState<number | null>(null)
  const ids = library ? [library.id] : server.sourceIds
  const idsKey = ids.join(',')
  useEffect(() => {
    let active = true
    Promise.all(ids.map(id => window.electronAPI.servers.removalCount(server.provider, id)))
      .then(counts => { if (active) setRemovalCount(counts.reduce((sum, count) => sum + count, 0)) }, () => { /* Keeps "its tracks". */ })
    return () => { active = false }
  }, [server.provider, idsKey])
  const theirCount = removalCount ? plural(removalCount, 'track') : null

  const remove = async () => {
    if (removing) return
    setRemoving(true)
    setError(null)
    try {
      if (library) await removePlexLibrary(library.id, deleteTracks)
      else await removeServer(server, deleteTracks)
      onClose()
    } catch (failure) {
      setError(cleanIpcError(failure, library ? 'Couldn’t remove this library.' : 'Couldn’t remove this server.'))
      setRemoving(false)
    }
  }

  const option = (value: boolean, title: string, description: string) => (
    <button type="button" className={`servers-pick-item${value ? ' is-danger' : ''}${deleteTracks === value ? ' is-on' : ''}`}
      aria-pressed={deleteTracks === value} disabled={removing} data-autofocus={value ? undefined : true}
      onClick={() => setDeleteTracks(value)}>
      <span className="servers-radio" />
      <span className="servers-pick-text"><span>{title}</span><span className="servers-hint">{description}</span></span>
    </button>
  )

  return (
    <ServerWindow phase={phase} title={`Remove ${library?.name ?? server.name}?`} subtitle={library ? server.name : undefined}
      busy={removing} onClose={onClose}
      footer={<>
        <button type="button" className="servers-btn" disabled={removing} onClick={onClose}>Cancel</button>
        <button type="button" className="servers-btn is-danger" disabled={removing} onClick={() => void remove()}>
          {removing ? <><Spinner />Removing…</> : `Remove ${library ? 'library' : 'server'}${deleteTracks ? ` and ${theirCount ?? 'tracks'}` : ''}`}
        </button>
      </>}>
      <p className="servers-window-text">
        {library ? `Astra stops syncing ${library.name} from ${server.name}.` : 'Astra stops syncing and forgets the connection.'}{' '}
        What should happen to its {theirCount ?? 'tracks'}?
      </p>
      <div className="servers-pick">
        {option(false, 'Keep them as unavailable', 'They stay in your playlists and listening history, marked unavailable.')}
        {option(true, 'Delete them from your library', 'Removes the tracks from Astra. This can’t be undone.')}
      </div>
      {error && <div className="servers-window-error" role="alert"><AlertIcon /><div>{error}</div></div>}
    </ServerWindow>
  )
}
