import { useEffect, useLayoutEffect, useRef, useState, type InputHTMLAttributes } from 'react'
import type { MiniPlayerSnapshot } from '../../../types/miniPlayer'

const SEEK_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])
const ACK_TOLERANCE_SECONDS = 0.35
const ACK_TIMEOUT_MS = 2000

interface SeekEdit { time: number; trackPath: string }
interface PendingSeek extends SeekEdit { snapshotAtCommit: MiniPlayerSnapshot | null }

export function useNotchSeek(snapshot: MiniPlayerSnapshot | null, expanded: boolean, sendSeek: (time: number) => void) {
  const trackPath = snapshot?.currentTrack?.path
  const duration = Math.max(0, snapshot?.duration ?? 0)
  const [draft, setDraft] = useState<number | null>(null)
  const [pending, setPending] = useState<PendingSeek | null>(null)
  const editRef = useRef<SeekEdit | null>(null)
  const pointerRef = useRef<number | null>(null)
  const keyboardRef = useRef(false)
  const timeoutRef = useRef<number | null>(null)

  const clearTimeout = () => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }
  const cancelEdit = () => {
    editRef.current = null; pointerRef.current = null; keyboardRef.current = false
    setDraft(null)
  }
  const commitEdit = () => {
    const edit = editRef.current
    // Clear synchronously: pointer-up, lost capture, key-up and blur can all
    // finish one gesture before React has rendered another state update.
    editRef.current = null
    setDraft(null)
    if (!edit || !expanded || edit.trackPath !== trackPath || duration <= 0) return
    const request = { ...edit, snapshotAtCommit: snapshot }
    setPending(request)
    clearTimeout()
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null
      setPending(current => current === request ? null : current)
    }, ACK_TIMEOUT_MS)
    sendSeek(edit.time)
  }

  useLayoutEffect(() => {
    // Hiding cancels unfinished input, but a submitted seek survives closing
    // and reopening the panel while its playback snapshot is still in flight.
    cancelEdit()
  }, [expanded, trackPath, duration])

  useLayoutEffect(() => {
    clearTimeout(); setPending(null)
  }, [trackPath, duration])

  useEffect(() => {
    if (!pending || pending.trackPath !== trackPath || !snapshot || snapshot === pending.snapshotAtCommit) return
    if (Math.abs(snapshot.currentTime - pending.time) > ACK_TOLERANCE_SECONDS) return
    clearTimeout(); setPending(null)
  }, [snapshot, pending, trackPath])

  useEffect(() => () => clearTimeout(), [])

  const input: InputHTMLAttributes<HTMLInputElement> = {
    onPointerDown: event => {
      if (event.button !== 0) return
      pointerRef.current = event.pointerId
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    onChange: event => {
      const value = Number(event.currentTarget.value)
      if (!expanded || !trackPath || duration <= 0 || !Number.isFinite(value)) return
      const time = Math.max(0, Math.min(duration, value))
      editRef.current = { time, trackPath }; setDraft(time)
      // Accessibility range actions can change the value without pointer or
      // keyboard events. Those changes are complete edits in their own right.
      if (pointerRef.current === null && !keyboardRef.current) commitEdit()
    },
    onPointerUp: event => {
      if (pointerRef.current !== event.pointerId) return
      pointerRef.current = null; commitEdit()
    },
    onPointerCancel: () => cancelEdit(),
    onLostPointerCapture: event => {
      if (pointerRef.current !== event.pointerId) return
      pointerRef.current = null; commitEdit()
    },
    onKeyDown: event => {
      if (SEEK_KEYS.has(event.key)) keyboardRef.current = true
      else if (event.key === 'Escape') cancelEdit()
    },
    onKeyUp: event => {
      if (!SEEK_KEYS.has(event.key)) return
      keyboardRef.current = false; commitEdit()
    },
    onBlur: () => {
      pointerRef.current = null; keyboardRef.current = false
      // Commit only the stored edit, never the DOM value: a controlled range
      // may already have been restored to an older playback snapshot on blur.
      commitEdit()
    },
  }
  const progress = Math.max(0, Math.min(duration, draft ?? pending?.time ?? snapshot?.currentTime ?? 0))
  return { progress, input }
}
