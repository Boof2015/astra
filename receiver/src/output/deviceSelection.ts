import type { AlsaDeviceOption } from './alsaDevices'

export interface OutputDeviceSelectionOptions {
  getConfiguredDevice: () => string
  listDevices: () => AlsaDeviceOption[]
  persistDevice: (device: string) => void
  scheduleRestart: () => void
  /** Retry an unchanged configured id when the active backend is a fallback or failed null. */
  shouldRestartCurrentDevice?: () => boolean
  log: (message: string) => void
}

/**
 * Builds the web callback that validates, persists, and schedules an output-device change.
 * Keeping the effects injectable makes the important recovery path independently testable.
 */
export function createOutputDeviceSetter(
  options: OutputDeviceSelectionOptions
): (device: string) => boolean {
  return (device) => {
    if (device !== 'default' && !options.listDevices().some((option) => option.id === device)) {
      return false
    }
    if (device === options.getConfiguredDevice()) {
      if (!options.shouldRestartCurrentDevice?.()) return true
      options.log(`retrying configured audio output ${JSON.stringify(device)} — restarting to reopen the device`)
      options.scheduleRestart()
      return true
    }

    options.persistDevice(device)
    options.log(`audio output set to ${JSON.stringify(device)} — restarting to reopen the device`)
    options.scheduleRestart()
    return true
  }
}
