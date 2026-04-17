import { create } from 'zustand'
import type { LyricsPopoutWindowState } from '../../types/lyricsPopout'

const DEFAULT_LYRICS_POPOUT_WINDOW_STATE: LyricsPopoutWindowState = {
  isOpen: false
}

interface LyricsPopoutStore {
  windowState: LyricsPopoutWindowState
  setWindowState: (state: LyricsPopoutWindowState) => void
}

export const useLyricsPopoutStore = create<LyricsPopoutStore>((set) => ({
  windowState: { ...DEFAULT_LYRICS_POPOUT_WINDOW_STATE },
  setWindowState: (state) => set({
    windowState: {
      ...DEFAULT_LYRICS_POPOUT_WINDOW_STATE,
      ...state
    }
  })
}))
