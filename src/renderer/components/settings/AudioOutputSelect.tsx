import { useEffect, useRef, useState } from 'react'
import { useAudioSettingsStore } from '../../stores/audioSettingsStore'

export default function AudioOutputSelect() {
  const { availableDevices, selectedDeviceId, refreshDevices, selectDevice } = useAudioSettingsStore()
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  const handleToggle = async () => {
    if (!isOpen) {
      await refreshDevices()
    }
    setIsOpen(!isOpen)
  }

  const handleSelect = async (deviceId: string) => {
    await selectDevice(deviceId)
    setIsOpen(false)
  }

  const currentLabel = availableDevices.find(d => d.deviceId === selectedDeviceId)?.label

  return (
    <div className="audio-output-select" ref={menuRef}>
      <button
        className={`audio-output-btn ${isOpen ? 'active' : ''}`}
        onClick={handleToggle}
        title={currentLabel || 'Audio output device'}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M17 2H7c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-5 2c.83 0 1.5.67 1.5 1.5S12.83 7 12 7s-1.5-.67-1.5-1.5S11.17 4 12 4zm0 16c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
        </svg>
      </button>
      {isOpen && (
        <div className="audio-output-dropdown">
          <div className="audio-output-dropdown-title">Output Device</div>
          {availableDevices.length === 0 ? (
            <div className="audio-output-dropdown-empty">No devices found</div>
          ) : (
            availableDevices.map(device => (
              <button
                key={device.deviceId}
                className={`audio-output-dropdown-item ${device.deviceId === selectedDeviceId ? 'active' : ''}`}
                onClick={() => handleSelect(device.deviceId)}
              >
                <span className="audio-output-device-label">{device.label}</span>
                {device.deviceId === selectedDeviceId && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                  </svg>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
