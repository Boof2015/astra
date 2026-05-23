import { create } from 'zustand'

export interface LyricsEditorPanelRequest {
  id: number
  trackPaths: string[]
}

export interface OpenLyricsEditorPanelRequest {
  trackPaths: string[]
}

interface LyricsEditorStore {
  panelRequest: LyricsEditorPanelRequest | null
  openPanel: (request: OpenLyricsEditorPanelRequest) => void
  closePanel: () => void
}

let nextPanelRequestId = 0

function normalizePanelTrackPaths(trackPaths: string[]): string[] {
  const normalized = trackPaths
    .map((trackPath) => trackPath.trim())
    .filter((trackPath) => trackPath.length > 0)
  return Array.from(new Set(normalized))
}

export const useLyricsEditorStore = create<LyricsEditorStore>((set) => ({
  panelRequest: null,

  openPanel: (request) => {
    const trackPaths = normalizePanelTrackPaths(request.trackPaths)
    if (trackPaths.length === 0) return

    nextPanelRequestId += 1
    set({
      panelRequest: {
        id: nextPanelRequestId,
        trackPaths
      }
    })
  },

  closePanel: () => {
    set({ panelRequest: null })
  }
}))
