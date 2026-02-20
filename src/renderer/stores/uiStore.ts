import { create } from 'zustand'

export type AppView = 'home' | 'library' | 'eq' | 'settings' | 'playlist' | 'metadata'

interface UIStore {
  activeView: AppView
  showQueue: boolean
  showInfoSidebar: boolean
  showPipelineShelf: boolean
  isFullscreen: boolean
  setActiveView: (view: AppView) => void
  toggleQueue: () => void
  toggleInfoSidebar: () => void
  togglePipelineShelf: () => void
  setFullscreen: (fs: boolean) => void
}

export const useUIStore = create<UIStore>((set) => ({
  activeView: 'home',
  showQueue: false,
  showInfoSidebar: false,
  showPipelineShelf: false,
  isFullscreen: false,
  setActiveView: (view) => set({ activeView: view }),
  toggleQueue: () => set((s) => ({ showQueue: !s.showQueue })),
  toggleInfoSidebar: () => set((s) => ({ showInfoSidebar: !s.showInfoSidebar })),
  togglePipelineShelf: () => set((s) => ({ showPipelineShelf: !s.showPipelineShelf })),
  setFullscreen: (fs) => set({ isFullscreen: fs }),
}))
