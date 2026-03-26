import { useSyncExternalStore } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { usePlayerStore } from '../stores/playerStore'

type Listener = () => void

const listeners = new Set<Listener>()
let frameId: number | null = null
let initialized = false
let cachedCurrentTime = 0

function notifyListeners(): void {
  for (const listener of listeners) {
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
      notifyListeners()
      if (state.playbackState === 'playing') {
        startLoop()
      }
      return
    }

    if (state.playbackState !== prevState.playbackState) {
      if (state.playbackState === 'playing') {
        cachedCurrentTime = audioEngine.currentTime
        notifyListeners()
        startLoop()
        return
      }

      stopLoop()
      cachedCurrentTime = state.currentTime
      notifyListeners()
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
      notifyListeners()
      return
    }

    if (state.playbackState !== 'playing' && state.currentTime !== prevState.currentTime) {
      cachedCurrentTime = state.currentTime
      notifyListeners()
    }
  })
}

function subscribe(listener: Listener): () => void {
  ensureInitialized()
  listeners.add(listener)
  startLoop()

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopLoop()
    }
  }
}

function getSnapshot(): number {
  ensureInitialized()
  return usePlayerStore.getState().playbackState === 'playing'
    ? cachedCurrentTime
    : usePlayerStore.getState().currentTime
}

export function usePlaybackClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
