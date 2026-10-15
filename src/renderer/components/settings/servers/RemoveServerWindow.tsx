import { useEffect, useState } from 'react'
import type { PresencePhase } from '../../../hooks/usePresence'
import { cleanIpcError, plural } from './serverModel'
import { AlertIcon } from './ServerParts'
import { ServerWindow, Spinner } from './ServerWindow'
import { removeServer, type ServerEntry } from './useServers'

/** Remove a server. Its tracks are kept as unavailable unless you choose to delete them. */
export function RemoveServerWindow({ phase, server, onClose }: {
  phase: PresencePhase
  server: ServerEntry
  onClose: () => void
}) {
  const [deleteTracks, setDeleteTracks] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Exactly what "Delete them" deletes, read as the window opens: unlike the counts shown
  // elsewhere, it includes tracks the server no longer has. "Its tracks" until it's known.
  const [removalCount, setRemovalCount] = useState<number | null>(null)
  useEffect(() => {
    let active = true
    window.electronAPI.servers.removalCount(server.provider, server.id)
      .then(count => { if (active) setRemovalCount(count) }, () => { /* Keeps "its tracks". */ })
    return () => { active = false }
  }, [server.provider, server.id])
  const theirCount = removalCount ? plural(removalCount, 'track') : null

  const remove = async () => {
    if (removing) return
    setRemoving(true)
    setError(null)
    try {
      await removeServer(server, deleteTracks)
      onClose()
    } catch (failure) {
      setError(cleanIpcError(failure, 'Couldn’t remove this server.'))
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
    <ServerWindow phase={phase} title={`Remove ${server.name}?`} busy={removing} onClose={onClose}
      footer={<>
        <button type="button" className="servers-btn" disabled={removing} onClick={onClose}>Cancel</button>
        <button type="button" className="servers-btn is-danger" disabled={removing} onClick={() => void remove()}>
          {removing ? <><Spinner />Removing…</> : deleteTracks ? `Remove server and ${theirCount ?? 'tracks'}` : 'Remove server'}
        </button>
      </>}>
      <p className="servers-window-text">Astra stops syncing and forgets the connection. What should happen to its {theirCount ?? 'tracks'}?</p>
      <div className="servers-pick">
        {option(false, 'Keep them as unavailable', 'They stay in your playlists and listening history, marked unavailable.')}
        {option(true, 'Delete them from your library', 'Removes the tracks from Astra. This can’t be undone.')}
      </div>
      {error && <div className="servers-window-error" role="alert"><AlertIcon /><div>{error}</div></div>}
    </ServerWindow>
  )
}
