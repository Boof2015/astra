import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { PlexLibraryChoice } from '../../../../types/plex'
import type { PresencePhase } from '../../../hooks/usePresence'
import { useJellyfinSettingsStore } from '../../../stores/jellyfinSettingsStore'
import { usePlexSettingsStore } from '../../../stores/plexSettingsStore'
import { useSubsonicSettingsStore } from '../../../stores/subsonicSettingsStore'
import {
  addressHost, cleanIpcError, defaultServerName, detectionOrder, PROVIDER_KIND, subsonicProductName, type ServerProvider
} from './serverModel'
import { AlertIcon, CheckIcon, ExternalIcon, ServerSwitch } from './ServerParts'
import { ServerWindow, Spinner } from './ServerWindow'
import { FAVORITES_COPY } from './SyncRows'
import { finishAddingServer } from './useServers'
import { usePlexSignIn } from './usePlexSignIn'

type AddressProvider = 'subsonic' | 'jellyfin'
type Step = 'connect' | 'plex-wait' | 'plex-pick' | 'options'
type Detected =
  | { provider: AddressProvider; label: string }
  | { provider: 'plex'; serverId: string; serverName: string; library: PlexLibraryChoice }

async function testAddress(provider: AddressProvider, input: { baseUrl: string; username: string; password: string }) {
  try {
    return provider === 'subsonic'
      ? await window.electronAPI.subsonic.testSource(input)
      : await window.electronAPI.jellyfin.testSource(input)
  } catch (error) {
    return { ok: false, message: 'Connection failed.', error: cleanIpcError(error, 'Connection failed.') }
  }
}

/**
 * Add a server. No "pick a type" step: an address is tried as each server type
 * (Astra detects which), or you sign in with Plex. Then name it and choose what
 * syncs, both off. The window closes as soon as the server is added; it appears
 * in the list, syncing.
 */
export function AddServerWindow({ phase, onClose, onAdded }: {
  phase: PresencePhase
  onClose: () => void
  onAdded: (key: string) => void
}) {
  const [step, setStep] = useState<Step>('connect')
  const [address, setAddress] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [testing, setTesting] = useState(false)
  // 'missing': a field is empty. 'sign-in': no server type accepted it; `detail` is that type's reason when one was chosen.
  const [failure, setFailure] = useState<{ kind: 'missing' } | { kind: 'sign-in'; detail: string | null } | null>(null)
  const [detected, setDetected] = useState<Detected | null>(null)
  const [name, setName] = useState('')
  const [favorites, setFavorites] = useState(false)
  const [playlists, setPlaylists] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const plex = usePlexSignIn()
  const plexSources = usePlexSettingsStore(state => state.sources)
  const [serverId, setServerId] = useState('')
  const [libraries, setLibraries] = useState<PlexLibraryChoice[] | null>(null)
  const [libraryId, setLibraryId] = useState('')
  const [libraryError, setLibraryError] = useState<string | null>(null)
  // Each library request belongs to one sign-in and one server. A newer choice, a new
  // sign-in or leaving the picker makes older answers stale; they're ignored on arrival.
  const libraryRequest = useRef(0)
  const resetPlexChoice = () => {
    libraryRequest.current++
    setServerId('')
    setLibraries(null)
    setLibraryId('')
    setLibraryError(null)
  }
  useEffect(resetPlexChoice, [plex.status?.id])

  // Any edit after a failed attempt starts fresh.
  useEffect(() => { setFailure(null) }, [address, username, password])
  useEffect(() => { if (step === 'plex-wait' && plex.status?.state === 'ready') setStep('plex-pick') }, [step, plex.status?.state])

  const goToOptions = (next: Detected, suggestedName: string) => {
    setDetected(next)
    setName(suggestedName)
    setFavorites(false)
    setPlaylists(false)
    setAddError(null)
    setStep('options')
  }

  const connect = async (event?: FormEvent, only?: AddressProvider) => {
    event?.preventDefault()
    if (testing) return
    const input = { baseUrl: address.trim(), username: username.trim(), password }
    if (!input.baseUrl || !input.username || !input.password) {
      setFailure({ kind: 'missing' })
      return
    }
    setTesting(true)
    setFailure(null)
    let lastError: string | null = null
    for (const provider of only ? [only] : detectionOrder(input.baseUrl)) {
      const result = await testAddress(provider, input)
      if (result.ok) {
        setTesting(false)
        const label = provider === 'jellyfin' ? 'Jellyfin' : subsonicProductName((result as { serverType?: string | null }).serverType)
        goToOptions({ provider, label }, defaultServerName(input.baseUrl))
        return
      }
      lastError = result.error ?? result.message
    }
    setTesting(false)
    // With a chosen type, that type's own reason helps; after auto-detect it would be one of two guesses.
    setFailure({ kind: 'sign-in', detail: only ? lastError : null })
  }

  const startPlex = () => { resetPlexChoice(); setStep('plex-wait'); void plex.begin() }
  const restartPlex = () => { resetPlexChoice(); void plex.begin() }
  const backToConnect = () => { plex.cancel(); resetPlexChoice(); setStep('connect') }

  const chooseServer = async (id: string) => {
    if (id === serverId || !plex.status) return
    const request = ++libraryRequest.current
    setServerId(id)
    setLibraries(null)
    setLibraryId('')
    setLibraryError(null)
    try {
      const choices = await window.electronAPI.plex.libraries(plex.status.id, id)
      if (request !== libraryRequest.current) return
      setLibraries(choices)
      const open = choices.filter(choice => !isAdded(id, choice.id))
      // A server with one music library picks it for you.
      if (choices.length === 1 && open.length === 1) setLibraryId(choices[0].id)
    } catch (error) {
      if (request !== libraryRequest.current) return
      setLibraryError(cleanIpcError(error, 'Couldn’t load the music libraries on this server.'))
    }
  }
  const isAdded = (server: string, library: string) =>
    plexSources.some(source => source.server_id === server && source.library_id === library)

  const continueWithPlex = () => {
    const server = plex.status?.servers?.find(item => item.id === serverId)
    const library = libraries?.find(item => item.id === libraryId)
    if (!server || !library) return
    goToOptions({ provider: 'plex', serverId: server.id, serverName: server.name, library }, `${server.name} · ${library.name}`)
  }

  const add = async () => {
    if (!detected || adding || !name.trim()) return
    setAdding(true)
    setAddError(null)
    try {
      let provider: ServerProvider, id: number
      if (detected.provider === 'plex') {
        const signInId = plex.status?.id
        if (!signInId) throw new Error('The Plex sign-in ended. Go back and sign in again.')
        const source = await window.electronAPI.plex.connect({
          signInId, serverId: detected.serverId, libraryId: detected.library.id, name: name.trim()
        })
        plex.release()
        await usePlexSettingsStore.getState().refresh()
        provider = 'plex'
        id = source.id
      } else {
        // Through the API rather than the store: the store reports a failed library refresh
        // after saving as a failed save, which here would invite adding the server twice.
        const input = { name: name.trim(), baseUrl: address.trim(), username: username.trim(), password, enabled: true }
        const created = detected.provider === 'subsonic'
          ? await window.electronAPI.subsonic.createSource(input)
          : await window.electronAPI.jellyfin.createSource(input)
        await (detected.provider === 'subsonic' ? useSubsonicSettingsStore : useJellyfinSettingsStore).getState().refresh()
        provider = detected.provider
        id = created.id
      }
      onAdded(`${provider}:${id}`)
      void finishAddingServer({ provider, id }, { favorites, playlists })
    } catch (error) {
      setAddError(cleanIpcError(error, 'Couldn’t add this server.'))
      setAdding(false)
    }
  }

  const cancelButton = <button type="button" className="servers-btn" disabled={adding} onClick={onClose}>Cancel</button>
  let body, footer

  if (step === 'connect') {
    body = (
      <>
        <form className="servers-form" onSubmit={event => void connect(event)}>
          <label className="servers-field">
            <span>Server address</span>
            <input className="servers-input is-mono" data-autofocus type="text" value={address} disabled={testing}
              placeholder="http://192.168.1.10:4533" autoComplete="off" spellCheck={false}
              onChange={event => setAddress(event.target.value)} />
          </label>
          <div className="servers-field-row">
            <label className="servers-field">
              <span>Username</span>
              <input className="servers-input" type="text" value={username} disabled={testing} autoComplete="off"
                spellCheck={false} onChange={event => setUsername(event.target.value)} />
            </label>
            <label className="servers-field">
              <span>Password</span>
              <input className="servers-input" type="password" value={password} disabled={testing} autoComplete="off"
                onChange={event => setPassword(event.target.value)} />
            </label>
          </div>
          {failure?.kind === 'missing' && (
            <div className="servers-window-error" role="alert">
              <AlertIcon /><div>Enter the server address, username and password.</div>
            </div>
          )}
          {failure?.kind === 'sign-in' && (
            <div className="servers-window-error" role="alert">
              <AlertIcon />
              <div>
                <strong>Couldn’t sign in to {addressHost(address)}.</strong> {failure.detail ?? 'Check the address, username and password.'}
                <div className="servers-error-actions">
                  <span>Or choose the server type:</span>
                  <button type="button" className="servers-btn is-small" onClick={() => void connect(undefined, 'jellyfin')}>Jellyfin</button>
                  <button type="button" className="servers-btn is-small" onClick={() => void connect(undefined, 'subsonic')}>Subsonic / Navidrome</button>
                </div>
              </div>
            </div>
          )}
          <div className="servers-form-foot">
            <p className="servers-hint">Works with Jellyfin, Navidrome and other Subsonic servers. Astra detects which one.</p>
            <button type="submit" className="servers-btn is-accent" disabled={testing}>
              {testing ? <><Spinner />Connecting…</> : 'Connect'}
            </button>
          </div>
        </form>
        <div className="servers-or"><span>or</span></div>
        <button type="button" className="servers-btn servers-plex-btn" disabled={testing} onClick={startPlex}>Sign in with Plex</button>
      </>
    )
    footer = cancelButton
  } else if (step === 'plex-wait') {
    body = plex.error ? (
      <div className="servers-window-error" role="alert"><AlertIcon /><div>{plex.error}</div></div>
    ) : (
      <div className="servers-wait" role="status">
        <Spinner />
        <div>
          <strong>Finish signing in to Plex in your browser.</strong>
          <p className="servers-hint">Astra continues here automatically once you approve.</p>
          <button type="button" className="servers-btn is-small" disabled={plex.starting} onClick={restartPlex}>
            <ExternalIcon />Open browser again
          </button>
        </div>
      </div>
    )
    footer = <>
      <button type="button" className="servers-btn" onClick={backToConnect}>Back</button>
      <span className="servers-spacer" />{cancelButton}
    </>
  } else if (step === 'plex-pick') {
    const servers = plex.status?.servers ?? []
    const open = libraries?.filter(choice => !isAdded(serverId, choice.id)) ?? []
    body = (
      <>
        <div className="servers-ok-line"><CheckIcon />Signed in to Plex as {plex.status?.username ?? 'you'}</div>
        <div className="servers-field">
          <span>Server</span>
          {servers.length ? (
            <div className="servers-pick">
              {servers.map(server => (
                <button key={server.id} type="button" className={`servers-pick-item${serverId === server.id ? ' is-on' : ''}`}
                  aria-pressed={serverId === server.id} onClick={() => void chooseServer(server.id)}>
                  <span className="servers-radio" /><span>{server.name}</span>
                  <span className="servers-pick-tag">{server.owned ? 'Owned' : 'Shared with you'}</span>
                </button>
              ))}
            </div>
          ) : <p className="servers-hint">This Plex account has no servers Astra can use.</p>}
        </div>
        {serverId && (
          <div className="servers-field">
            <span>Music library</span>
            {libraryError ? <p className="servers-hint is-warn">{libraryError}</p>
              : !libraries ? <p className="servers-hint"><Spinner /> Loading libraries…</p>
              : !libraries.length ? <p className="servers-hint">This server has no music libraries.</p>
              : libraries.length === 1 && open.length === 1
                ? <p className="servers-hint">{libraries[0].name} is the only music library on this server, so it’s picked for you.</p>
                : (
                  <div className="servers-pick">
                    {libraries.map(choice => {
                      const added = isAdded(serverId, choice.id)
                      return (
                        <button key={choice.id} type="button" disabled={added}
                          className={`servers-pick-item${libraryId === choice.id ? ' is-on' : ''}`}
                          aria-pressed={libraryId === choice.id} onClick={() => setLibraryId(choice.id)}>
                          <span className="servers-radio" /><span>{choice.name}</span>
                          {added && <span className="servers-pick-tag">Already added</span>}
                        </button>
                      )
                    })}
                  </div>
                )}
          </div>
        )}
      </>
    )
    footer = <>
      <button type="button" className="servers-btn" onClick={backToConnect}>Back</button>
      <span className="servers-spacer" />
      <button type="button" className="servers-btn is-accent" disabled={!libraryId} onClick={continueWithPlex}>Continue</button>
    </>
  } else {
    const provider = detected?.provider ?? 'subsonic'
    const copy = FAVORITES_COPY[provider]
    body = (
      <>
        <div className="servers-ok-line">
          <CheckIcon />
          {detected?.provider === 'plex'
            ? `Signed in to Plex · ${detected.serverName}`
            : `Connected to ${detected?.label ?? PROVIDER_KIND[provider]} as ${username.trim()}`}
        </div>
        <label className="servers-field">
          <span>Name</span>
          <input className="servers-input" data-autofocus type="text" value={name} disabled={adding} autoComplete="off"
            onChange={event => setName(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') void add() }} />
        </label>
        <div className="servers-window-rows">
          <div className="servers-row">
            <div className="servers-row-text">
              <span className="servers-label">{copy.label}</span>
              <span className="servers-sub">
                {copy.sub}{favorites && ' You’ll compare existing values once the first sync finishes.'}
              </span>
            </div>
            <ServerSwitch checked={favorites} label={copy.switchLabel} disabled={adding} onChange={setFavorites} />
          </div>
          <div className="servers-row">
            <div className="servers-row-text">
              <span className="servers-label">Sync playlists</span>
              <span className="servers-sub">Show this server’s playlists in Astra and save your edits back to it.</span>
            </div>
            <ServerSwitch checked={playlists} label="Sync playlists" disabled={adding} onChange={setPlaylists} />
          </div>
        </div>
        <p className="servers-hint">You can change these later on the server’s page.</p>
        {addError && <div className="servers-window-error" role="alert"><AlertIcon /><div>{addError}</div></div>}
      </>
    )
    footer = <>
      <button type="button" className="servers-btn" disabled={adding}
        onClick={() => setStep(detected?.provider === 'plex' ? 'plex-pick' : 'connect')}>Back</button>
      <span className="servers-spacer" />
      <button type="button" className="servers-btn is-accent" disabled={adding || !name.trim()} onClick={() => void add()}>
        {adding ? <><Spinner />Adding…</> : 'Add server'}
      </button>
    </>
  }

  return (
    <ServerWindow phase={phase} title="Add a server" busy={adding} onClose={onClose} footer={footer}>
      {body}
    </ServerWindow>
  )
}
