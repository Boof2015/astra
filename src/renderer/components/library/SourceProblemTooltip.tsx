import { useCallback, useEffect, useState, type FocusEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ServerEntry } from '../settings/servers/useServers'

interface Tip { key: string; left: number; top: number }

/** What a problem dot means. Offline and sign-in expired read the same until source status carries an error kind. */
export function sourceProblemText(server: ServerEntry): { title: string; detail: string } {
  return {
    title: 'Can’t sync',
    detail: server.error?.trim() || 'Astra couldn’t sync with this server. Its tracks may be unavailable until it’s back.'
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
