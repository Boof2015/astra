import { create } from 'zustand'

export type AppView = 'home' | 'library' | 'eq' | 'settings'

interface UIStore {
  activeView: AppView
  showQueue: boolean
  showInfoSidebar: boolean
  isFullscreen: boolean
  setActiveView: (view: AppView) => void
  toggleQueue: () => void
  toggleInfoSidebar: () => void
  setFullscreen: (fs: boolean) => void
}

export const useUIStore = create<UIStore>((set) => ({
  activeView: 'library',
  showQueue: false,
  showInfoSidebar: false,
  isFullscreen: false,
  setActiveView: (view) => set({ activeView: view }),
  toggleQueue: () => set((s) => ({ showQueue: !s.showQueue })),
  toggleInfoSidebar: () => set((s) => ({ showInfoSidebar: !s.showInfoSidebar })),
  setFullscreen: (fs) => set({ isFullscreen: fs }),
}))
