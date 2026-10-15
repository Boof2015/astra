import { useEffect, useRef, useState } from 'react'
import { useLibraryStore } from '../../stores/libraryStore'
import { useProviderSyncStore } from '../../stores/providerSyncStore'
import { planOutageNotices, useServerNoticeStore, type ServerNotice } from '../../stores/serverNoticeStore'
import { useUIStore } from '../../stores/uiStore'
import { isUserSyncing, useServers, type ServerEntry } from '../settings/servers/useServers'

type CueVisibility = 'hidden' | 'visible'

// Same rhythm as the update cue.
const SERVER_CUE_HIDE_MS = 5200
const SERVER_CUE_CLEAR_MS = 5600

function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

/**
 * Watches for servers that stop syncing in the background: one cue per outage,
 * cleared once the server is healthy again or turned off. A failure during a sync
 * the user started shows on its row instead.
 */
function useOutageNotices(servers: ServerEntry[]) {
  const memory = useRef({ notified: new Set<string>(), known: new Set<string>() })
  useEffect(() => {
    const store = useServerNoticeStore.getState()
    const plan = planOutageNotices(servers, memory.current, isUserSyncing)
    for (const server of plan.push) store.push({ kind: 'problem', serverKey: server.key, message: server.error ?? undefined })
    for (const key of plan.clear) store.clear('problem', key)
    for (const key of plan.removed) store.clearServer(key)
  }, [servers])
}

/**
 * Server news as one of Astra's corner cues (like the update and decode cues):
 * the server's tile, a label, two lines, an action badge and the countdown bar.
 * Server cues queue, so they show one at a time.
 */
export default function ServerNotices() {
  const servers = useServers()
  useOutageNotices(servers)
  const head = useServerNoticeStore(state => state.queue[0])
  const working = useProviderSyncStore(state => state.working)
  const isFullscreen = useUIStore(state => state.isFullscreen)
  const [visibility, setVisibility] = useState<CueVisibility>('hidden')

  useEffect(() => {
    if (!head) {
      setVisibility('hidden')
      return
    }
    setVisibility('visible')
    const id = head.id
    const hideTimer = window.setTimeout(() => setVisibility('hidden'), SERVER_CUE_HIDE_MS)
    const clearTimer = window.setTimeout(() => useServerNoticeStore.getState().dismiss(id), SERVER_CUE_CLEAR_MS)
    return () => {
      window.clearTimeout(hideTimer)
      window.clearTimeout(clearTimer)
    }
  }, [head?.id])

  if (!head) return null
  const server = servers.find(item => item.key === head.serverKey)
  const content = cueContent(head, server?.name ?? 'A server')
  const dismiss = () => useServerNoticeStore.getState().dismiss(head.id)

  let badge = null
  if (head.kind === 'review' && head.ref) {
    const ref = head.ref
    badge = (
      <button type="button" className="server-cue-badge" disabled={working}
        onClick={() => { dismiss(); void useProviderSyncStore.getState().openReview(ref) }}>
        Review
      </button>
    )
  } else if (head.kind === 'ready' && head.serverKey) {
    const key = head.serverKey
    badge = (
      <button type="button" className="server-cue-badge" onClick={() => {
        useLibraryStore.getState().setSelectedSourceFilters([key])
        useUIStore.getState().setActiveView('library')
        dismiss()
      }}>
        Show in library
      </button>
    )
  }

  return (
    <aside
      className={`server-cue server-cue-${visibility}${isFullscreen ? ' server-cue-fullscreen' : ''}`}
      aria-live="polite"
      aria-hidden={visibility === 'hidden'}
    >
      <div className="fullscreen-next-cue-card">
        <div className="fullscreen-next-cue-artwork" aria-hidden="true">
          <div className="fullscreen-next-cue-placeholder server-cue-tile">{server?.monogram ?? '!'}</div>
        </div>
        <div className="fullscreen-next-cue-meta">
          <span className="fullscreen-next-cue-label">{content.label}</span>
          <div className="fullscreen-next-cue-title">{content.title}</div>
          {content.detail && <div className="fullscreen-next-cue-artist server-cue-detail">{content.detail}</div>}
        </div>
        {badge}
      </div>
      <div className="fullscreen-next-cue-progress">
        <div key={head.id} className="fullscreen-next-cue-fill server-cue-fill" />
      </div>
    </aside>
  )
}

function cueContent(notice: ServerNotice, name: string): { label: string; title: string; detail?: string } {
  switch (notice.kind) {
    case 'review':
      return { label: 'Server Sync', title: `${plural(notice.count ?? 1, 'change')} on both sides`, detail: name }
    case 'problem':
      // Offline and sign-in expired read the same until source status carries an error kind.
      return { label: 'Server Problem', title: `Can’t sync ${name}`, detail: notice.message }
    case 'ready':
      return { label: 'Server Ready', title: `${name} is ready`, detail: 'Its music is in your library.' }
    default:
      return { label: 'Server Sync', title: 'Couldn’t save that change', detail: notice.message }
  }
}
