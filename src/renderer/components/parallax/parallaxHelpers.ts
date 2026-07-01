import { useEffect, useState } from 'react'
import type { ParallaxStatus } from '../../../types/parallax'

export type ParallaxRole = 'host' | 'sink' | 'none'

/**
 * Roles are exclusive (a machine plays music OR is a speaker, never both — see the role chooser),
 * but derive defensively in case a migrated install has both backend flags set. Host wins because
 * it owns the richer management surface.
 */
export function deriveParallaxRole(status: ParallaxStatus | null): ParallaxRole {
  if (status?.host.enabled) return 'host'
  if (status?.sink.sinkEnabled) return 'sink'
  return 'none'
}

/**
 * True when Parallax is already configured in any way — used to skip the guided first-run flow for
 * users upgrading from before the setup flow existed.
 */
export function anyParallaxConfigPresent(status: ParallaxStatus | null, activeSinkCount: number): boolean {
  if (!status) return false
  return Boolean(
    status.host.enabled ||
    status.sink.sinkEnabled ||
    activeSinkCount > 0 ||
    status.sink.hasPersistedConnection
  )
}

export function formatParallaxTrimMs(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(0)} ms`
}

export function formatParallaxLastSeen(value: number | null | undefined): string {
  return value ? new Date(value).toLocaleString() : 'Never'
}

export interface EndpointIdentity {
  hostname: string
  lanIps: string[]
}

/** This machine's hostname + LAN IPs, used to identify a speaker so the user can find it on the host. */
export function useEndpointIdentity(): EndpointIdentity | null {
  const [identity, setIdentity] = useState<EndpointIdentity | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.parallax.getEndpointIdentity().then((value) => {
      if (!cancelled) setIdentity(value)
    }).catch(() => {
      if (!cancelled) setIdentity({ hostname: '', lanIps: [] })
    })
    return () => { cancelled = true }
  }, [])
  return identity
}
