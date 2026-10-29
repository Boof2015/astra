import { useState } from 'react'
import { ServerStatusLine } from './ServerHeader'
import { ChevronRightIcon, CompactProgress } from './ServerParts'
import { syncServer, type ServerEntry } from './useServers'

function RetryButton({ server }: { server: ServerEntry }) {
  const [pending, setPending] = useState(false)
  return (
    <button type="button" className="servers-btn is-accent servers-row-action" disabled={pending}
      onClick={() => { setPending(true); void syncServer(server).finally(() => setPending(false)) }}>
      Retry
    </button>
  )
}

/**
 * Several servers: a quiet row each, opening that server's page. Only a problem
 * gets color, and a button when there's something to do about it. The name is the row's button and stretches over the
 * whole row, so the row is one click target and one tab stop.
 */
export function ServerList({ servers, highlightKey, onOpen, onReconnect }: {
  servers: ServerEntry[]
  highlightKey?: string | null
  onOpen: (key: string) => void
  /** Sign in again (Plex) or change the connection (others). */
  onReconnect: (server: ServerEntry) => void
}) {
  return (
    <div className="servers-group">
      {servers.map(server => (
        <div key={server.key}
          className={`servers-row servers-server-row${server.enabled ? '' : ' is-hidden'}${server.key === highlightKey ? ' is-new' : ''}`}>
          <span className="servers-tile" aria-hidden="true">{server.monogram}</span>
          <div className="servers-row-text">
            <button type="button" className="servers-name servers-name-btn" data-server-key={server.key}
              title={server.state === 'failed' ? server.error ?? undefined : undefined}
              onClick={() => onOpen(server.key)}>
              {server.name}
            </button>
            <span className="servers-meta">
              {server.kind} · {server.address ? <span className="servers-mono">{server.host}</span> : server.host}
            </span>
          </div>
          <div className="servers-status-col">
            {server.state === 'syncing' && server.progress
              ? <CompactProgress progress={server.progress} />
              : <ServerStatusLine server={server} variant="list" />}
            {/* Offline needs no button: Astra retries on its own, and the status says so. */}
            {server.problem === 'sync' && <RetryButton server={server} />}
            {server.problem === 'signed-out' && (
              <button type="button" className="servers-btn is-accent servers-row-action" onClick={() => onReconnect(server)}>Reconnect</button>
            )}
          </div>
          <span className="servers-chevron" aria-hidden="true"><ChevronRightIcon /></span>
        </div>
      ))}
    </div>
  )
}
