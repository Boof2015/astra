export interface DesktopIntegrationPrefs {
  trayEnabled: boolean
  closeToTray: boolean
}

export interface TrayRendererState {
  sleepTimerExpiresAtMs: number | null
  globalHotkeysSuspended: boolean
  configuredGlobalHotkeyCount: number
}

export type TraySettingsSection = 'appearance' | 'integrations'

export type TrayRendererCommand =
  | { type: 'reveal-current-track' }
  | { type: 'open-settings'; section: TraySettingsSection }
  | { type: 'open-phone-sync-conflicts' }
  | { type: 'start-sleep-timer'; minutes: 15 | 30 | 45 | 60 }
  | { type: 'cancel-sleep-timer' }
  | { type: 'set-global-hotkeys-suspended'; suspended: boolean }

export const DEFAULT_DESKTOP_INTEGRATION_PREFS: DesktopIntegrationPrefs = {
  trayEnabled: true,
  closeToTray: false,
}

export const DEFAULT_TRAY_RENDERER_STATE: TrayRendererState = {
  sleepTimerExpiresAtMs: null,
  globalHotkeysSuspended: false,
  configuredGlobalHotkeyCount: 0,
}
