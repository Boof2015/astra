import { useCallback, useEffect, useState, type FocusEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ServerEntry } from '../settings/servers/useServers'

interface Tip { key: string; left: number; top: number }

/** What a problem dot means. */
export function sourceProblemText(server: ServerEntry): { title: string; detail: string } {
  if (server.problem === 'offline') return { title: 'Offline', detail: 'Its tracks are unavailable until it’s back.' }
  if (server.problem === 'signed-out') return { title: 'Sign-in expired', detail: 'Its tracks are unavailable until you sign in again.' }
  return {
    title: 'Can’t sync',
    detail: server.error?.trim() || 'Astra couldn’t sync with this server.'
  }
}

/**
 * The library's source chips show a dot when a server has a problem, explained on
 * hover or focus. The tooltip renders in a portal because the chip row can scroll
 * sideways, which would clip it.
 */
export function useSourceProblemTooltip(problems: ReadonlyMap<string, ServerEntry>) {
  const [tip, setTip] = useState<Tip | null>(null)
  const show = useCallback((server: ServerEntry) => (event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setTip({ key: server.key, left: rect.left + rect.width / 2, top: rect.bottom + 8 })
  }, [])
  const hide = useCallback(() => setTip(null), [])
  // The tooltip explains a current problem: it goes when the server recovers or disappears,
  // and always shows that server's latest message.
  const server = tip ? problems.get(tip.key) : undefined
  useEffect(() => { if (tip && !server) setTip(null) }, [tip, server])
  const element = tip && server ? createPortal(
    <div className="library-source-tooltip" role="tooltip" style={{ left: tip.left, top: tip.top }}>
      <strong>{sourceProblemText(server).title}</strong> · {sourceProblemText(server).detail}
    </div>,
    document.body
  ) : null
  return { show, hide, element }
}
