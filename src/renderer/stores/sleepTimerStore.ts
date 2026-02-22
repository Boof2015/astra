import { create } from 'zustand'
import { usePlayerStore } from './playerStore'

export const SLEEP_TIMER_PRESET_MINUTES = [15, 30, 45, 60] as const
export const SLEEP_TIMER_MIN_MINUTES = 1
export const SLEEP_TIMER_MAX_MINUTES = 720

const SLEEP_TIMER_TICK_INTERVAL_MS = 1000
const MINUTE_TO_MS = 60_000

export type SleepTimerStartResult =
  | { ok: true }
  | { ok: false; reason: 'invalid-duration' | 'playback-inactive' }

interface SleepTimerStore {
  isActive: boolean
  durationMs: number | null
  startedAtMs: number | null
  expiresAtMs: number | null
  remainingMs: number
  lastExpiredAtMs: number | null
  startTimer: (minutes: number) => SleepTimerStartResult
  replaceTimer: (minutes: number) => SleepTimerStartResult
  cancelTimer: () => void
  tick: (nowMs?: number) => void
}

function hasActivePlaybackSession(): boolean {
  const { currentTrack, playbackState } = usePlayerStore.getState()
  if (!currentTrack) return false
  return playbackState === 'playing' || playbackState === 'paused'
}

function isValidDurationMinutes(minutes: number): boolean {
  if (!Number.isFinite(minutes)) return false
  if (!Number.isInteger(minutes)) return false
  return minutes >= SLEEP_TIMER_MIN_MINUTES && minutes <= SLEEP_TIMER_MAX_MINUTES
}

export const useSleepTimerStore = create<SleepTimerStore>((set, get) => {
  let tickTimer: number | null = null

  const stopTicking = (): void => {
    if (tickTimer !== null) {
      window.clearInterval(tickTimer)
      tickTimer = null
    }
  }

  const startTicking = (): void => {
    if (tickTimer !== null) return
    tickTimer = window.setInterval(() => {
      get().tick()
    }, SLEEP_TIMER_TICK_INTERVAL_MS)
  }

  return {
    isActive: false,
    durationMs: null,
    startedAtMs: null,
    expiresAtMs: null,
    remainingMs: 0,
    lastExpiredAtMs: null,

    startTimer: (minutes: number): SleepTimerStartResult => {
      if (!isValidDurationMinutes(minutes)) {
        return { ok: false, reason: 'invalid-duration' }
      }

      if (!hasActivePlaybackSession()) {
        return { ok: false, reason: 'playback-inactive' }
      }

      const now = Date.now()
      const durationMs = minutes * MINUTE_TO_MS
      const expiresAtMs = now + durationMs

      set({
        isActive: true,
        durationMs,
        startedAtMs: now,
        expiresAtMs,
        remainingMs: durationMs,
        lastExpiredAtMs: null
      })

      startTicking()
      return { ok: true }
    },

    replaceTimer: (minutes: number): SleepTimerStartResult => {
      return get().startTimer(minutes)
    },

    cancelTimer: (): void => {
      stopTicking()
      set((state) => ({
        isActive: false,
        durationMs: null,
        startedAtMs: null,
        expiresAtMs: null,
        remainingMs: 0,
        lastExpiredAtMs: state.lastExpiredAtMs
      }))
    },

    tick: (nowMs?: number): void => {
      const state = get()
      if (!state.isActive || state.expiresAtMs == null) {
        stopTicking()
        return
      }

      const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now()
      const remainingMs = Math.max(0, state.expiresAtMs - now)

      if (remainingMs > 0) {
        if (remainingMs !== state.remainingMs) {
          set({ remainingMs })
        }
        return
      }

      stopTicking()
      set({
        isActive: false,
        durationMs: null,
        startedAtMs: null,
        expiresAtMs: null,
        remainingMs: 0,
        lastExpiredAtMs: now
      })

      usePlayerStore.getState().pause()
    }
  }
})
