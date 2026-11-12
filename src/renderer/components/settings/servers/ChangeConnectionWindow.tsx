import { useState, type FormEvent } from 'react'
import type { PresencePhase } from '../../../hooks/usePresence'
import { useJellyfinSettingsStore } from '../../../stores/jellyfinSettingsStore'
import { useSubsonicSettingsStore } from '../../../stores/subsonicSettingsStore'
import { addressHost, cleanIpcError, connectionFailureText } from './serverModel'
import { AlertIcon } from './ServerParts'
import { ServerWindow, Spinner } from './ServerWindow'
import { syncServer, useProviderSyncStatus, useRemotePlaylistStatuses, type ServerEntry } from './useServers'

const SYNCED_VALUES = { subsonic: 'favorites and ratings', jellyfin: 'favorites', plex: 'ratings' } as const

/**
 * Change an address server's name, address, username or password. New credentials
 * are checked before saving, and a blank password keeps the stored one. Only when
 * the credentials change, and only if something syncs, does it warn that syncing
 * turns off (the backend resets consent whenever the connection changes).
 */
export function ChangeConnectionWindow({ phase, server, onClose }: {
  phase: PresencePhase
  server: ServerEntry
  onClose: () => void
}) {
  const provider = server.provider === 'jellyfin' ? 'jellyfin' : 'subsonic'
  const [name, setName] = useState(server.name)
  const [address, setAddress] = useState(server.address ?? '')
  const [username, setUsername] = useState(server.user)
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const favoritesOn = !!useProviderSyncStatus({ provider: server.provider, sourceId: server.id })?.enabled
  const playlistsOn = !!useRemotePlaylistStatuses().find(item =>
    item.provider === server.playlistRef.provider && item.sourceId === server.playlistRef.sourceId)?.enabled
  const credentialsChanged = address.trim() !== (server.address ?? '') || username.trim() !== server.user || password !== ''
  const turnsOff = [favoritesOn ? SYNCED_VALUES[provider] : null, playlistsOn ? 'playlists' : null].filter(Boolean) as string[]

  const save = async (event?: FormEvent) => {
    event?.preventDefault()
    if (saving) return
    if (!name.trim() || !address.trim() || !username.trim()) {
      setError('Enter a name, the server address and the username.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (credentialsChanged) {
        const input = {
          baseUrl: address.trim(),
          username: username.trim(),
          ...(password ? { password } : { passwordFromSourceId: server.id })
        }
        const result = provider === 'subsonic'
          ? await window.electronAPI.subsonic.testSource(input)
          : await window.electronAPI.jellyfin.testSource(input)
        if (!result.ok) {
          const text = connectionFailureText(addressHost(address), [{ failure: result.failure, error: result.error }])
          throw new Error(`${text.title} ${text.detail}`)
        }
      }
      const update = {
        name: name.trim(),
        ...(credentialsChanged ? { baseUrl: address.trim(), username: username.trim(), ...(password ? { password } : {}) } : {})
      }
      // Through the API, then a refresh that reports its own errors: a failed refresh isn't a failed save.
      if (provider === 'subsonic') await window.electronAPI.subsonic.updateSource(server.id, update)
      else await window.electronAPI.jellyfin.updateSource(server.id, update)
      await (provider === 'subsonic' ? useSubsonicSettingsStore : useJellyfinSettingsStore).getState().refresh()
      onClose()
      if (credentialsChanged) void syncServer(server)
    } catch (failure) {
      setError(cleanIpcError(failure, 'Couldn’t save the connection.'))
      setSaving(false)
    }
  }

  return (
    <ServerWindow phase={phase} title="Change connection" subtitle={server.name} busy={saving} onClose={onClose}
      footer={<>
        <button type="button" className="servers-btn" disabled={saving} onClick={onClose}>Cancel</button>
        <button type="button" className="servers-btn is-accent" disabled={saving} onClick={() => void save()}>
          {saving ? <><Spinner />Checking…</> : 'Save'}
        </button>
      </>}>
      {credentialsChanged && turnsOff.length > 0 && (
        <div className="servers-window-warn" role="status">
          <AlertIcon />
          <span>
            Saving a new address, username or password turns off syncing {turnsOff.join(', and ')} for this server.
            Turn it back on afterwards to compare again.
          </span>
        </div>
      )}
      <form className="servers-form" onSubmit={event => void save(event)}>
        <label className="servers-field">
          <span>Name</span>
          <input className="servers-input" type="text" value={name} disabled={saving} autoComplete="off"
            onChange={event => setName(event.target.value)} />
        </label>
        <label className="servers-field">
          <span>Server address</span>
          <input className="servers-input is-mono" data-autofocus type="text" value={address} disabled={saving}
            autoComplete="off" spellCheck={false} onChange={event => setAddress(event.target.value)} />
        </label>
        <div className="servers-field-row">
          <label className="servers-field">
            <span>Username</span>
            <input className="servers-input" type="text" value={username} disabled={saving} autoComplete="off"
              spellCheck={false} onChange={event => setUsername(event.target.value)} />
          </label>
          <label className="servers-field">
            <span>Password</span>
            <input className="servers-input" type="password" value={password} disabled={saving} autoComplete="off"
              placeholder="Leave blank to keep it" onChange={event => setPassword(event.target.value)} />
          </label>
        </div>
        <button type="submit" hidden />
      </form>
      {error && <div className="servers-window-error" role="alert"><AlertIcon /><div>{error}</div></div>}
    </ServerWindow>
  )
}
