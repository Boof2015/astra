import { useEffect, useRef } from 'react'
import { isInspecting } from './inspectMode'

/**
 * Lets a component declare that the studio can open it on demand.
 *
 * A large share of Astra's copy lives in modals, wizards and transient cues that only appear
 * after a specific sequence of actions — a pairing failure, a duplicate scan finding something,
 * an update becoming available. A translator cannot reasonably reproduce all of those, so
 * without this those strings are effectively unreachable in the running app.
 *
 * Registration is opt-in per surface because the state that opens a modal lives in its parent
 * (usually a `useState` boolean), and there is no way to reach it generically. One line in the
 * parent makes a surface reachable:
 *
 *   useTranslationSurface('Playlists ▸ Create dialog', () => setCreateOpen(true))
 *
 * Outside studio mode the hook does nothing at all, so this costs a packaged build nothing.
 */

export interface TranslationSurface {
  id: string
  open: () => void
}

const surfaces = new Map<string, TranslationSurface>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function subscribeToSurfaces(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function listSurfaces(): TranslationSurface[] {
  return [...surfaces.values()].sort((left, right) => left.id.localeCompare(right.id))
}

export function useTranslationSurface(id: string, open: () => void): void {
  // Callers pass an inline arrow, so the callback identity changes every render. Registering on
  // identity would churn the list the studio is showing; capturing the first closure would go
  // stale. A ref keeps registration stable while always invoking the current callback.
  const latest = useRef(open)
  latest.current = open

  useEffect(() => {
    if (!isInspecting) return undefined
    surfaces.set(id, { id, open: () => latest.current() })
    notify()
    return () => {
      surfaces.delete(id)
      notify()
    }
  }, [id])
}
