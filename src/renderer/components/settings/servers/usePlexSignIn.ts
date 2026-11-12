import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlexSignInStatus } from '../../../../types/plex'
import { cleanIpcError } from './serverModel'

/**
 * Plex's browser sign-in: start it (which opens the browser), poll until it's
 * approved, and cancel it if the window closes first. Starting again cancels
 * the previous attempt, so "Open browser again" never leaves two sessions.
 */
export function usePlexSignIn() {
  const [status, setStatus] = useState<PlexSignInStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const session = useRef<string | null>(null)
  const generation = useRef(0)
  const alive = useRef(true)

  const cancel = useCallback(() => {
    generation.current++
    if (session.current) void window.electronAPI.plex.cancelSignIn(session.current).catch(() => {})
    session.current = null
    setStatus(null)
    setStarting(false)
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      generation.current++
      if (session.current) void window.electronAPI.plex.cancelSignIn(session.current).catch(() => {})
    }
  }, [])

  const begin = useCallback(async () => {
    cancel()
    setError(null)
    setStarting(true)
    const attempt = generation.current
    try {
      const value = await window.electronAPI.plex.beginSignIn()
      if (!alive.current || attempt !== generation.current) {
        void window.electronAPI.plex.cancelSignIn(value.id).catch(() => {})
        return
      }
      session.current = value.id
      setStatus(value)
    } catch (failure) {
      if (alive.current && attempt === generation.current) setError(cleanIpcError(failure, 'Plex sign-in couldn’t start.'))
    } finally {
      if (alive.current && attempt === generation.current) setStarting(false)
    }
  }, [cancel])

  useEffect(() => {
    if (status?.state !== 'waiting') return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const value = await window.electronAPI.plex.pollSignIn(status.id)
        if (stopped) return
        setStatus(value)
        if (value.state === 'waiting') timer = setTimeout(poll, 1500)
      } catch (failure) {
        if (stopped) return
        setError(cleanIpcError(failure, 'Plex sign-in didn’t finish.'))
        cancel()
      }
    }
    timer = setTimeout(poll, 1500)
    return () => { stopped = true; clearTimeout(timer) }
  }, [status?.id, status?.state, cancel])

  /** A successful connect ends the session in the main process; don't cancel it again. */
  const release = useCallback(() => { session.current = null }, [])

  return { status, error, starting, begin, cancel, release }
}
