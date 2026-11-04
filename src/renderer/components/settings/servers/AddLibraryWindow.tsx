import { useEffect, useState } from 'react'
import type { PlexLibraryChoice } from '../../../../types/plex'
import type { PresencePhase } from '../../../hooks/usePresence'
import { usePlexSettingsStore } from '../../../stores/plexSettingsStore'
import { cleanIpcError } from './serverModel'
import { AlertIcon } from './ServerParts'
import { ServerWindow, Spinner } from './ServerWindow'
import { finishAddingServer, type ServerEntry } from './useServers'

/**
 * Add more music libraries from a Plex server that's already in Astra. It uses the
 * server's stored sign-in, so there's no browser step. Libraries already here show as
 * added; the rest start selected. The new ones then sync, with the server's settings.
 */
export function AddLibraryWindow({ phase, server, onClose }: {
  phase: PresencePhase
  server: ServerEntry
  onClose: () => void
}) {
  const [choices, setChoices] = useState<PlexLibraryChoice[] | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const added = new Set(usePlexSettingsStore(state => state.sources)
    .filter(source => server.sourceIds.includes(source.id)).map(source => source.library_id))

  useEffect(() => {
    let active = true
    window.electronAPI.plex.serverLibraries(server.id)
      .then(found => {
        if (!active) return
        setChoices(found)
        setSelected(found.filter(choice => !added.has(choice.id)).map(choice => choice.id))
      })
      .catch(failure => { if (active) setLoadError(cleanIpcError(failure, `Couldn’t load the music libraries on ${server.name}.`)) })
    return () => { active = false }
    // Read once, as the window opens; what's already added is checked then.
  }, [server.id])

  const open = choices?.filter(choice => !added.has(choice.id)) ?? []
  const chosen = open.filter(choice => selected.includes(choice.id))
  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])

  const add = async () => {
    if (adding || !chosen.length) return
    setAdding(true)
    setError(null)
    try {
      const sources = await window.electronAPI.plex.addLibraries(server.id, chosen.map(choice => choice.id))
      await usePlexSettingsStore.getState().refresh()
      onClose()
      void finishAddingServer({ provider: 'plex', id: server.id, sourceIds: sources.map(source => source.id) },
        { favorites: false, playlists: false })
    } catch (failure) {
      setError(cleanIpcError(failure, 'Couldn’t add these libraries.'))
      setAdding(false)
    }
  }

  let body
  if (loadError) body = <div className="servers-window-error" role="alert"><AlertIcon /><div>{loadError}</div></div>
  else if (!choices) body = <p className="servers-hint"><Spinner /> Loading libraries…</p>
  else if (!open.length) body = <p className="servers-window-text">All of {server.name}’s music libraries are already in Astra.</p>
  else {
    body = (
      <>
        <div className="servers-pick" role="group" aria-label="Music libraries">
          {choices.map(choice => {
            const isAdded = added.has(choice.id)
            const on = isAdded || selected.includes(choice.id)
            return (
              <button key={choice.id} type="button" role="checkbox" disabled={isAdded || adding}
                className={`servers-pick-item${on ? ' is-on' : ''}`} aria-checked={on} onClick={() => toggle(choice.id)}>
                <span className="servers-check" /><span>{choice.name}</span>
                {isAdded && <span className="servers-pick-tag">Added</span>}
              </button>
            )
          })}
        </div>
        <p className="servers-hint">They use {server.name}’s settings and sync once they’re added.</p>
        {error && <div className="servers-window-error" role="alert"><AlertIcon /><div>{error}</div></div>}
      </>
    )
  }

  return (
    <ServerWindow phase={phase} title="Add a library" subtitle={server.name} busy={adding} onClose={onClose}
      footer={<>
        <button type="button" className="servers-btn" disabled={adding} onClick={onClose}>Cancel</button>
        {open.length > 0 && (
          <button type="button" className="servers-btn is-accent" disabled={adding || !chosen.length} onClick={() => void add()}>
            {adding ? <><Spinner />Adding…</> : chosen.length > 1 ? 'Add libraries' : 'Add library'}
          </button>
        )}
      </>}>
      {body}
    </ServerWindow>
  )
}
