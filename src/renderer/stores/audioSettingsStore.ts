import { create } from 'zustand'
import { audioEngine } from '../audio/AudioEngine'

interface AudioDevice {
  deviceId: string
  label: string
}

interface AudioSettingsStore {
  selectedDeviceId: string
  availableDevices: AudioDevice[]

  refreshDevices: () => Promise<void>
  selectDevice: (deviceId: string) => Promise<void>
  initFromSaved: () => Promise<void>
}

const STORAGE_KEY = 'astra-audio-output-device'

export const useAudioSettingsStore = create<AudioSettingsStore>((set, get) => ({
  selectedDeviceId: '',
  availableDevices: [],

  refreshDevices: async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const audioOutputs = devices
        .filter(d => d.kind === 'audiooutput')
        .map(d => ({
          deviceId: d.deviceId,
          label: d.label || `Speaker (${d.deviceId.slice(0, 8)}...)`
        }))
      set({ availableDevices: audioOutputs })
    } catch {
      console.warn('Could not enumerate audio devices')
    }
  },

  selectDevice: async (deviceId: string) => {
    try {
      await audioEngine.setOutputDevice(deviceId)
      set({ selectedDeviceId: deviceId })
      localStorage.setItem(STORAGE_KEY, deviceId)
    } catch (err) {
      console.error('Failed to set audio output device:', err)
    }
  },

  initFromSaved: async () => {
    await get().refreshDevices()
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const { availableDevices } = get()
      const exists = availableDevices.some(d => d.deviceId === saved)
      if (exists) {
        await get().selectDevice(saved)
      } else {
        // Saved device no longer available, use default
        localStorage.removeItem(STORAGE_KEY)
      }
    }
  }
}))
