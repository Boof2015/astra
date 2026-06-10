import { useCallback, useSyncExternalStore } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { usePlayerStore } from '../stores/playerStore'

type Listener = () => void

interface ListenerEntry {
  precision: number
  lastQuantum: number
}

const listeners = new Map<Listener, ListenerEntry>()
let frameId: number | null = null
let initialized = false
let cachedCurrentTime = 0

function quantize(time: number, precision: number): number {
  return precision > 0 ? Math.floor(time / precision) * precision : time
}

// Listeners with a precision are only notified when their quantum changes,
// so coarse consumers (time labels, lyric sync) stop re-rendering at frame
// rate during playback. force bypasses the quantum check for discontinuities
// (seeks, track changes, pause) where every consumer must resync.
function notifyListeners(force = false): void {
  for (const [listener, entry] of listeners) {
    if (entry.precision > 0) {
      const quantum = Math.floor(cachedCurrentTime / entry.precision)
      if (!force && quantum === entry.lastQuantum) continue
      entry.lastQuantum = quantum
    }
    listener()
  }
}

function stopLoop(): void {
  if (frameId !== null) {
    window.cancelAnimationFrame(frameId)
    frameId = null
  }
}

function tick(): void {
  frameId = null

  if (listeners.size === 0 || usePlayerStore.getState().playbackState !== 'playing') {
    return
  }

  const nextTime = audioEngine.currentTime
  if (Math.abs(nextTime - cachedCurrentTime) >= 1 / 240) {
    cachedCurrentTime = nextTime
    notifyListeners()
  }

  frameId = window.requestAnimationFrame(tick)
}

function startLoop(): void {
  if (frameId !== null || listeners.size === 0 || usePlayerStore.getState().playbackState !== 'playing') {
    return
  }

  cachedCurrentTime = audioEngine.currentTime
  frameId = window.requestAnimationFrame(tick)
}

function ensureInitialized(): void {
  if (initialized) return
  initialized = true
  cachedCurrentTime = usePlayerStore.getState().currentTime

  usePlayerStore.subscribe((state, prevState) => {
    const trackChanged = state.currentTrack?.path !== prevState.currentTrack?.path

    if (trackChanged) {
      cachedCurrentTime = state.currentTime
      notifyListeners(true)
      if (state.playbackState === 'playing') {
        startLoop()
      }
      return
    }

    if (state.playbackState !== prevState.playbackState) {
      if (state.playbackState === 'playing') {
        cachedCurrentTime = audioEngine.currentTime
        notifyListeners(true)
        startLoop()
        return
      }

      stopLoop()
      cachedCurrentTime = state.currentTime
      notifyListeners(true)
      return
    }

    if (
      state.playbackState === 'playing'
      && state.currentTime !== prevState.currentTime
      && (
        state.currentTime === 0
        || state.currentTime < prevState.currentTime
      )
    ) {
      cachedCurrentTime = state.currentTime
      notifyListeners(true)
      return
    }

    if (state.playbackState !== 'playing' && state.currentTime !== prevState.currentTime) {
      cachedCurrentTime = state.currentTime
      notifyListeners(true)
    }
  })
}

function subscribeWithPrecision(listener: Listener, precision: number): () => void {
  ensureInitialized()
  listeners.set(listener, {
    precision,
    lastQuantum: precision > 0 ? Math.floor(cachedCurrentTime / precision) : 0
  })
  startLoop()

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopLoop()
    }
  }
}

function getSnapshot(precision: number): number {
  ensureInitialized()
  const time = usePlayerStore.getState().playbackState === 'playing'
    ? cachedCurrentTime
    : usePlayerStore.getState().currentTime
  return quantize(time, precision)
}

/**
 * Playback position driven by a shared rAF loop.
 *
 * @param precision Re-render granularity in seconds. 0 (default) updates at
 * frame rate. Pass the coarsest value the consumer can tolerate, e.g. 1/30
 * for a seek bar playhead, 0.1 for lyric sync, 0.25 for a time label.
 */
export function usePlaybackClock(precision = 0): number {
  const subscribe = useCallback(
    (listener: Listener) => subscribeWithPrecision(listener, precision),
    [precision]
  )
  const getSnap = useCallback(() => getSnapshot(precision), [precision])
  return useSyncExternalStore(subscribe, getSnap, getSnap)
}
