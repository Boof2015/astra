import { useRef, useState } from 'react'
import type { ProviderSyncRef } from '../../../types/providerSync'
import type { RemotePlaylistDestination } from '../../../types/remotePlaylists'
import { cleanIpcError, PROVIDER_KIND, PROVIDER_MONOGRAM } from '../settings/servers/serverModel'
import { useServers } from '../settings/servers/useServers'

export const destinationKey = (destination: ProviderSyncRef) => `${destination.provider}:${destination.sourceId}`

/** One line under a destination: who it saves as, or why it can't be used. */
function destinationLine(choice: RemotePlaylistDestination, user: string | undefined): string {
  if (choice.reasonKind === 'not-in-use') return 'Not in use. Turn it on in Settings → Servers.'
  if (choice.reasonKind === 'sync-off') return 'Playlist sync is off for this server.'
  if (choice.reasonKind === 'tracks') return 'The selected tracks aren’t on this server.'
  if (choice.reason) return choice.reason
  return [PROVIDER_KIND[choice.provider], user].filter(Boolean).join(' · ')
}

/**
 * Where a server playlist is saved: a card per server. Servers that can't take it
 * say why, with a fix where there is one. Turning on playlist sync needs no
 * comparison, so it happens right here; the list refreshes and picks that server.
 */
export default function ServerDestinationPicker({ destinations, value, disabled, onChange }: {
  destinations: RemotePlaylistDestination[]
  value: string
  disabled: boolean
  onChange: (key: string) => void
}) {
  const servers = useServers()
  const [turningOn, setTurningOn] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Counts the user's own picks. A Turn on that finishes after any pick (even one that
  // lands back on the same server) leaves the selection alone.
  const picks = useRef(0)
  const pick = (key: string) => { picks.current++; onChange(key) }

  const turnOn = async (choice: RemotePlaylistDestination) => {
    const key = destinationKey(choice)
    const picksWhenStarted = picks.current
    setTurningOn(key)
    setError(null)
    try {
      await window.electronAPI.remotePlaylists.setEnabled({ provider: choice.provider, sourceId: choice.sourceId }, true)
      // Pick it only if the user hasn't picked a server while it was turning on.
      if (picks.current === picksWhenStarted) onChange(key)
    } catch (failure) {
      setError(cleanIpcError(failure, 'Couldn’t turn on playlist sync.'))
    } finally {
      setTurningOn(null)
    }
  }

  return (
    <div className="playlist-destinations" role="radiogroup" aria-label="Server">
      {destinations.map(choice => {
        const key = destinationKey(choice)
        const server = servers.find(item => item.key === key)
        const selected = value === key && !choice.reason
        return (
          <div key={key} className={`playlist-destination${selected ? ' is-on' : ''}${choice.reason ? ' is-unusable' : ''}`}>
            <button type="button" role="radio" aria-checked={selected} className="playlist-destination-pick"
              disabled={disabled || !!choice.reason} onClick={() => pick(key)}>
              <span className="servers-radio" />
              <span className="servers-tile" aria-hidden="true">{PROVIDER_MONOGRAM[choice.provider]}</span>
              <span className="playlist-destination-text">
                <span className="playlist-destination-name">{server?.name ?? choice.name}</span>
                <span className="playlist-destination-line">{destinationLine(choice, server?.user)}</span>
              </span>
            </button>
            {choice.reasonKind === 'sync-off' && (
              <button type="button" className="servers-btn is-small" disabled={disabled || turningOn !== null}
                onClick={() => void turnOn(choice)}>
                {turningOn === key ? 'Turning on…' : 'Turn on'}
              </button>
            )}
          </div>
        )
      })}
      {error && <p className="playlist-create-error" role="alert">{error}</p>}
    </div>
  )
}
