import { useState } from 'react'
import { formatAgo } from './serverModel'
import { ServerMenu, type ServerMenuAction } from './ServerMenu'
import { AlertIcon, ProgressRow, RefreshIcon, ServerSwitch } from './ServerParts'
import { setServerEnabled, syncServer, useNow, type ServerEntry } from './useServers'

function StatusLine({ server, variant }: { server: ServerEntry; variant: 'header' | 'list' }) {
  const now = useNow()
  switch (server.state) {
    case 'off':
      return <span className="servers-status is-off"><i className="servers-dot" />{variant === 'header' ? 'Not in use · hidden from your library' : 'Not in use'}</span>
    case 'failed': {
      const text = server.problem === 'offline'
        ? (variant === 'header' ? `Can’t reach ${server.host} · retrying` : 'Offline · retrying')
        : server.problem === 'signed-out' ? 'Sign-in expired' : 'Sync failed'
      return <span className="servers-status is-warn"><i className="servers-dot" />{text}</span>
    }
    case 'syncing':
      return <span className="servers-status"><i className="servers-dot is-syncing" />Syncing</span>
    case 'checking':
      return <span className="servers-status"><i className="servers-dot is-checking" />Checking…</span>
    default: {
      const ago = server.lastSyncAt ? formatAgo(server.lastSyncAt, now) : null
      const text = !ago ? 'Connected' : variant === 'header' ? `Connected · synced ${ago}` : `Connected · ${ago}`
      return <span className="servers-status"><i className="servers-dot is-ok" />{text}</span>
    }
  }
}
export { StatusLine as ServerStatusLine }

function sentence(text: string | null): string | null {
  const trimmed = text?.trim()
  if (!trimmed) return null
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

export function ServerMeta({ server }: { server: ServerEntry }) {
  return (
    <span className="servers-meta">
      {server.kind} · {server.address ? <span className="servers-mono">{server.host}</span> : server.host} · {server.user}
    </span>
  )
}

/** What fixes a failed server, in a sentence, for the notice under its header. */
function problemNotice(server: ServerEntry): string {
  if (server.problem === 'offline') return 'Its tracks show as unavailable until the server is back. Astra tries again every 20 minutes.'
  if (server.problem === 'signed-out') {
    return server.provider === 'plex'
      ? 'Its tracks are unavailable until you sign in to Plex again.'
      : 'The server didn’t accept the saved username and password. Its tracks are unavailable until you update them.'
  }
  return `${sentence(server.error) ?? 'Astra couldn’t sync with this server.'} Astra tries again every 20 minutes.`
}

/**
 * Sync now; Retry now after a failure; Reconnect when the sign-in expired (it opens
 * Sign in again for Plex, Change connection otherwise). Disabled while syncing or not in use.
 */
function PrimaryAction({ server, onReconnect }: { server: ServerEntry; onReconnect: () => void }) {
  const [pending, setPending] = useState(false)
  const busy = pending || server.state === 'syncing'
  if (server.problem === 'signed-out') {
    return <button type="button" className="servers-btn is-accent" onClick={onReconnect}>Reconnect</button>
  }
  return (
    <button type="button" className="servers-btn" disabled={!server.enabled || busy}
      onClick={() => { setPending(true); void syncServer(server).finally(() => setPending(false)) }}>
      <RefreshIcon />
      {busy && server.enabled ? 'Syncing…' : server.state === 'failed' ? 'Retry now' : 'Sync now'}
    </button>
  )
}

/** Name, status and address, with the main action. The same block heads a server's page. */
export function ServerHeader({ server, onMenuAction }: { server: ServerEntry; onMenuAction: (action: ServerMenuAction) => void }) {
  return (
    <>
      <div className="servers-hero">
        <span className="servers-tile is-large" aria-hidden="true">{server.monogram}</span>
        <div className="servers-row-text">
          <span className="servers-name is-large">{server.name}</span>
          <StatusLine server={server} variant="header" />
          <ServerMeta server={server} />
        </div>
        <div className="servers-hero-actions">
          <PrimaryAction server={server} onReconnect={() => onMenuAction('connection')} />
          <ServerMenu server={server} onAction={onMenuAction} />
        </div>
      </div>
      {server.state === 'failed' && (
        <div className="servers-notice" role="status">
          <AlertIcon />
          <span>{problemNotice(server)}</span>
        </div>
      )}
      {server.state === 'syncing' && server.progress && <ProgressRow progress={server.progress} />}
    </>
  )
}

/** Turning a server off is also how you hide its music, so it's a row rather than a menu item. */
export function UseServerRow({ server }: { server: ServerEntry }) {
  const [pending, setPending] = useState(false)
  return (
    <div className="servers-row">
      <div className="servers-row-text">
        <span className="servers-label">Use this server</span>
        <span className="servers-sub">
          {server.enabled
            ? 'Turn off to hide its music and stop syncing. Your settings are kept.'
            : 'Its music is hidden and Astra won’t contact it. Your settings are kept.'}
        </span>
      </div>
      <ServerSwitch checked={server.enabled} label="Use this server" disabled={pending}
        onChange={enabled => { setPending(true); void setServerEnabled(server, enabled).finally(() => setPending(false)) }} />
    </div>
  )
}
