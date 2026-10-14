import { useState } from 'react'
import { ServerStatusLine } from './ServerHeader'
import { CompactProgress } from './ServerParts'
import { syncServer, type ServerEntry } from './useServers'

function RetryButton({ server }: { server: ServerEntry }) {
  const [pending, setPending] = useState(false)
  return (
    <button type="button" className="servers-btn is-accent" disabled={pending}
      onClick={() => { setPending(true); void syncServer(server).finally(() => setPending(false)) }}>
      Retry
    </button>
  )
}

/** Several servers: a quiet row each. Only a problem gets color and a button. */
export function ServerList({ servers }: { servers: ServerEntry[] }) {
  return (
    <div className="servers-group">
      {servers.map(server => (
        <div key={server.key} className={`servers-row servers-server-row${server.enabled ? '' : ' is-hidden'}`}>
          <span className="servers-tile" aria-hidden="true">{server.monogram}</span>
          <div className="servers-row-text">
            <span className="servers-name">{server.name}</span>
            <span className="servers-meta">
              {server.kind} · {server.address ? <span className="servers-mono">{server.host}</span> : server.host}
            </span>
          </div>
          <div className="servers-status-col" title={server.state === 'failed' ? server.error ?? undefined : undefined}>
            {server.state === 'syncing' && server.progress
              ? <CompactProgress progress={server.progress} />
              : <ServerStatusLine server={server} variant="list" />}
            {server.state === 'failed' && <RetryButton server={server} />}
          </div>
        </div>
      ))}
    </div>
  )
}
