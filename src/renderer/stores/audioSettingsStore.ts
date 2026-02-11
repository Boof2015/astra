import { create } from 'zustand'
import { audioEngine } from '../audio/AudioEngine'

interface AudioDevice {
  deviceId: string
  label: string
}

interface AudioSettingsStore {
  selectedDeviceId: string
  availableDevices: AudioDevice[]
  selectedOutputChannelCount: number | null
  multichannelEnabled: boolean
  channelRoutingMap: number[] | null

  refreshDevices: () => Promise<void>
  refreshOutputChannelCount: () => Promise<void>
  selectDevice: (deviceId: string) => Promise<void>
  setMultichannelEnabled: (enabled: boolean) => Promise<void>
  setChannelRoutingMap: (map: number[] | null) => Promise<void>
  resetChannelRoutingMap: () => Promise<void>
  initFromSaved: () => Promise<void>
}

const STORAGE_KEY = 'astra-audio-output-device'
const MULTICHANNEL_STORAGE_KEY = 'astra-audio-multichannel-enabled'
const ROUTING_STORAGE_KEY = 'astra-audio-channel-routing-map'

export const useAudioSettingsStore = create<AudioSettingsStore>((set, get) => ({
  selectedDeviceId: '',
  availableDevices: [],
  selectedOutputChannelCount: null,
  multichannelEnabled: false,
  channelRoutingMap: null,

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
      await get().refreshOutputChannelCount()
    } catch {
      console.warn('Could not enumerate audio devices')
    }
  },

  refreshOutputChannelCount: async () => {
    try {
      await audioEngine.ensureContextReady()
      const maxChannels = audioEngine.getOutputMaxChannelCount()
      set({ selectedOutputChannelCount: maxChannels })
    } catch {
      set({ selectedOutputChannelCount: null })
    }
  },

  selectDevice: async (deviceId: string) => {
    try {
      await audioEngine.setOutputDevice(deviceId)
      set({ selectedDeviceId: deviceId })
      localStorage.setItem(STORAGE_KEY, deviceId)
      await get().refreshOutputChannelCount()
    } catch (err) {
      console.error('Failed to set audio output device:', err)
    }
  },

  setMultichannelEnabled: async (enabled: boolean) => {
    set({ multichannelEnabled: enabled })
    localStorage.setItem(MULTICHANNEL_STORAGE_KEY, enabled ? '1' : '0')
    await audioEngine.setMultichannelEnabled(enabled)
  },

  setChannelRoutingMap: async (map: number[] | null) => {
    const normalized = map && map.length > 0
      ? map.map((value) => {
          if (!Number.isFinite(value)) return -1
          const rounded = Math.trunc(value)
          return rounded >= -1 ? rounded : -1
        })
      : null

    set({ channelRoutingMap: normalized })

    if (normalized) {
      localStorage.setItem(ROUTING_STORAGE_KEY, JSON.stringify(normalized))
    } else {
      localStorage.removeItem(ROUTING_STORAGE_KEY)
    }

    await audioEngine.setChannelRoutingMap(normalized)
  },

  resetChannelRoutingMap: async () => {
    await get().setChannelRoutingMap(null)
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

    const savedMultichannel = localStorage.getItem(MULTICHANNEL_STORAGE_KEY)
    const multichannelEnabled = savedMultichannel === '1'
    await get().setMultichannelEnabled(multichannelEnabled)

    const savedRoutingMap = localStorage.getItem(ROUTING_STORAGE_KEY)
    if (!savedRoutingMap) return

    try {
      const parsed = JSON.parse(savedRoutingMap)
      if (Array.isArray(parsed)) {
        const map = parsed.map((value) => {
          if (!Number.isFinite(value)) return -1
          const rounded = Math.trunc(value)
          return rounded >= -1 ? rounded : -1
        })
        await get().setChannelRoutingMap(map)
      } else {
        localStorage.removeItem(ROUTING_STORAGE_KEY)
      }
    } catch {
      localStorage.removeItem(ROUTING_STORAGE_KEY)
    }
  }
}))
