import { create } from 'zustand'

/**
 * Asks Settings → Servers to open a server's sign-in window. Corner cues live outside
 * Settings, so a cue's "Sign in" leaves a request that the Servers section takes once
 * it's showing.
 */
interface ServerWindowRequestState {
  reconnect: string | null
  requestReconnect(serverKey: string): void
  take(): string | null
}

export const useServerWindowRequest = create<ServerWindowRequestState>((set, get) => ({
  reconnect: null,
  requestReconnect: serverKey => set({ reconnect: serverKey }),
  take: () => {
    const key = get().reconnect
    if (key) set({ reconnect: null })
    return key
  }
}))
