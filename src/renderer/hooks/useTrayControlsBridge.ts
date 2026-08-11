import { useEffect, useMemo } from 'react'
import type { TrayRendererCommand } from '../../types/desktopIntegration'
import {
  countConfiguredGlobalInputBindings,
  useInputBindingStore,
} from '../stores/inputBindingStore'
import { usePhoneRemoteSettingsStore } from '../stores/phoneRemoteSettingsStore'
import { useSleepTimerStore } from '../stores/sleepTimerStore'
import { useUIStore } from '../stores/uiStore'
import { useJumpToNowPlaying } from './useJumpToNowPlaying'

export function useTrayControlsBridge(): void {
  const jumpToNowPlaying = useJumpToNowPlaying()
  const sleepTimerExpiresAtMs = useSleepTimerStore((state) => state.expiresAtMs)
  const globalHotkeysSuspended = useInputBindingStore((state) => state.globalUserSuspended)
  const globalEnabled = useInputBindingStore((state) => state.globalEnabled)
  const overrides = useInputBindingStore((state) => state.overrides)
  const configuredGlobalHotkeyCount = useMemo(
    () => countConfiguredGlobalInputBindings(overrides, globalEnabled),
    [globalEnabled, overrides]
  )

  useEffect(() => {
    const handleCommand = (command: TrayRendererCommand): void => {
      switch (command.type) {
        case 'reveal-current-track':
          void jumpToNowPlaying()
          return
        case 'open-settings': {
          const ui = useUIStore.getState()
          ui.setPendingSettingsSection(command.section)
          ui.setActiveView('settings')
          return
        }
        case 'open-phone-sync-conflicts': {
          const ui = useUIStore.getState()
          ui.setPendingSettingsSection('integrations')
          ui.setActiveView('settings')
          usePhoneRemoteSettingsStore.getState().openSyncConflictResolver()
          return
        }
        case 'start-sleep-timer':
          useSleepTimerStore.getState().replaceTimer(command.minutes)
          return
        case 'cancel-sleep-timer':
          useSleepTimerStore.getState().cancelTimer()
          return
        case 'set-global-hotkeys-suspended':
          useInputBindingStore.getState().setGlobalUserSuspended(command.suspended)
      }
    }

    const unsubscribe = window.electronAPI.trayControls.onCommand(handleCommand)
    window.electronAPI.trayControls.markReady()
    return () => {
      unsubscribe()
      window.electronAPI.trayControls.markNotReady()
    }
  }, [jumpToNowPlaying])

  useEffect(() => {
    window.electronAPI.trayControls.publishRendererState({
      sleepTimerExpiresAtMs,
      globalHotkeysSuspended,
      configuredGlobalHotkeyCount,
    })
  }, [configuredGlobalHotkeyCount, globalHotkeysSuspended, sleepTimerExpiresAtMs])
}
