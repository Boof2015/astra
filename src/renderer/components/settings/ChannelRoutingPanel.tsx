import { useMemo } from 'react'
import { useAudioSettingsStore } from '../../stores/audioSettingsStore'
import { usePlayerStore } from '../../stores/playerStore'

interface SpeakerChannel {
  id: string
  label: string
}

function buildSpeakerLayout(channelCount: number): SpeakerChannel[] {
  switch (channelCount) {
    case 2:
      return [
        { id: 'FL', label: 'Front Left' },
        { id: 'FR', label: 'Front Right' },
      ]
    case 4:
      return [
        { id: 'FL', label: 'Front Left' },
        { id: 'FR', label: 'Front Right' },
        { id: 'RL', label: 'Rear Left' },
        { id: 'RR', label: 'Rear Right' },
      ]
    case 6:
      return [
        { id: 'FL', label: 'Front Left' },
        { id: 'FR', label: 'Front Right' },
        { id: 'C', label: 'Center' },
        { id: 'LFE', label: 'LFE/Sub' },
        { id: 'SL', label: 'Side Left' },
        { id: 'SR', label: 'Side Right' },
      ]
    case 8:
      return [
        { id: 'FL', label: 'Front Left' },
        { id: 'FR', label: 'Front Right' },
        { id: 'C', label: 'Center' },
        { id: 'LFE', label: 'LFE/Sub' },
        { id: 'SL', label: 'Side Left' },
        { id: 'SR', label: 'Side Right' },
        { id: 'BL', label: 'Back Left' },
        { id: 'BR', label: 'Back Right' },
      ]
    default:
      return buildFallbackLayout(channelCount)
  }
}

function buildFallbackLayout(channelCount: number): SpeakerChannel[] {
  return Array.from({ length: channelCount }, (_, i) => ({
    id: `CH${i + 1}`,
    label: `Channel ${i + 1}`,
  }))
}

function buildSourceLayout(channelCount: number): SpeakerChannel[] {
  return Array.from({ length: channelCount }, (_, i) => ({
    id: `SRC${i + 1}`,
    label: `Decoded Channel ${i + 1}`,
  }))
}

function formatChannels(value: number | null): string {
  if (!value || value <= 0) return '\u2014'
  return `${value}ch`
}

function getChannelId(index: number, layout: SpeakerChannel[]): string {
  return layout[index]?.id ?? `CH${index + 1}`
}

function getChannelLabel(index: number, layout: SpeakerChannel[]): string {
  return layout[index]?.label ?? `Channel ${index + 1}`
}

export default function ChannelRoutingPanel() {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const {
    selectedDeviceId,
    availableDevices,
    selectedOutputChannelCount,
    multichannelEnabled,
    setMultichannelEnabled,
    channelRoutingMap,
    setChannelRoutingMap,
    resetChannelRoutingMap,
  } = useAudioSettingsStore()

  const trackChannels = currentTrack?.channels ?? null
  const outputChannels = selectedOutputChannelCount && selectedOutputChannelCount > 0
    ? selectedOutputChannelCount
    : null

  const hasTrackChannels = Boolean(trackChannels && trackChannels > 0)
  const hasOutputChannels = Boolean(outputChannels && outputChannels > 0)
  const resolvedTrackChannels = hasTrackChannels ? (trackChannels as number) : 0
  const resolvedOutputChannels = hasOutputChannels ? (outputChannels as number) : 0
  const effectiveOutputChannels = hasOutputChannels
    ? (multichannelEnabled ? resolvedOutputChannels : Math.min(2, resolvedOutputChannels))
    : 0

  const sourceLayout = useMemo(
    () => (hasTrackChannels ? buildSourceLayout(resolvedTrackChannels) : []),
    [hasTrackChannels, resolvedTrackChannels]
  )
  const outputLayout = useMemo(
    () => (hasOutputChannels ? buildSpeakerLayout(resolvedOutputChannels) : []),
    [hasOutputChannels, resolvedOutputChannels]
  )

  const effectiveRouting = useMemo(() => {
    if (!hasOutputChannels) return []

    return Array.from({ length: resolvedOutputChannels }, (_, outputIndex) => {
      if (!hasTrackChannels) return -1

      if (!multichannelEnabled) {
        return outputIndex < Math.min(2, resolvedOutputChannels) ? Math.min(outputIndex, resolvedTrackChannels - 1) : -1
      }

      const manualSourceIndex = channelRoutingMap?.[outputIndex]
      if (typeof manualSourceIndex === 'number' && Number.isInteger(manualSourceIndex)) {
        if (manualSourceIndex === -1) return -1
        if (manualSourceIndex >= 0 && manualSourceIndex < resolvedTrackChannels) return manualSourceIndex
      }

      return outputIndex < resolvedTrackChannels ? outputIndex : -1
    })
  }, [
    channelRoutingMap,
    hasOutputChannels,
    hasTrackChannels,
    multichannelEnabled,
    resolvedOutputChannels,
    resolvedTrackChannels,
  ])

  const mappedChannels = multichannelEnabled
    ? effectiveRouting.reduce((total, sourceIndex) => (
      sourceIndex >= 0 ? total + 1 : total
    ), 0)
    : (hasTrackChannels ? Math.min(2, resolvedOutputChannels) : 0)

  const downmixActive = hasTrackChannels && hasOutputChannels && resolvedTrackChannels > effectiveOutputChannels
  const hasManualRouting = Boolean(channelRoutingMap && channelRoutingMap.length > 0)

  const selectedDeviceLabel = availableDevices.find((d) => d.deviceId === selectedDeviceId)?.label
    ?? 'System Default Device'

  const sourceOptions = useMemo(() => {
    if (!hasTrackChannels) return []
    return Array.from({ length: resolvedTrackChannels }, (_, index) => ({
      value: index,
      label: `${getChannelId(index, sourceLayout)} - ${getChannelLabel(index, sourceLayout)}`
    }))
  }, [hasTrackChannels, resolvedTrackChannels, sourceLayout])

  const handleMappingChange = (outputIndex: number, rawValue: string) => {
    if (!hasOutputChannels || !hasTrackChannels || !multichannelEnabled) return

    const parsed = Number(rawValue)
    const sourceIndex = Number.isFinite(parsed) ? Math.trunc(parsed) : -1
    const normalizedSourceIndex = sourceIndex >= -1 && sourceIndex < resolvedTrackChannels
      ? sourceIndex
      : -1

    const nextMap = Array.from({ length: resolvedOutputChannels }, (_, index) => (
      index === outputIndex ? normalizedSourceIndex : (effectiveRouting[index] ?? -1)
    ))

    const isDefaultMap = nextMap.every((mappedSourceIndex, index) => {
      const defaultSource = index < resolvedTrackChannels ? index : -1
      return mappedSourceIndex === defaultSource
    })

    if (isDefaultMap) {
      void resetChannelRoutingMap()
      return
    }

    void setChannelRoutingMap(nextMap)
  }

  return (
    <div className="channel-routing-panel">
      <div className="channel-routing-header">
        <div className="channel-routing-title">Channel Routing</div>
        <div className="channel-routing-device">{selectedDeviceLabel}</div>
      </div>

      <div className="channel-routing-meta">
        <span className="channel-routing-chip">File {formatChannels(trackChannels)}</span>
        <span className="channel-routing-chip">Output {formatChannels(outputChannels)}</span>
        <button
          type="button"
          className={`channel-routing-mode-toggle ${multichannelEnabled ? 'active' : ''}`}
          onClick={() => void setMultichannelEnabled(!multichannelEnabled)}
        >
          {multichannelEnabled ? 'Multichannel On' : 'Stereo Safe'}
        </button>
        <span className="channel-routing-chip">Mapped {mappedChannels}/{formatChannels(outputChannels)}</span>
        {hasManualRouting && multichannelEnabled && (
          <span className="channel-routing-chip channel-routing-chip-active">Remap Active</span>
        )}
        {hasManualRouting && !multichannelEnabled && (
          <span className="channel-routing-chip">Remap Saved</span>
        )}
        {downmixActive && (
          <span className="channel-routing-chip channel-routing-chip-warning">
            Downmix {resolvedTrackChannels}{'->'}{effectiveOutputChannels}
          </span>
        )}
        {hasManualRouting && (
          <button
            type="button"
            className="channel-routing-reset-btn"
            onClick={() => void resetChannelRoutingMap()}
          >
            Reset Routing
          </button>
        )}
      </div>

      <div className="channel-routing-stage">
        <div className={`channel-routing-source-card ${hasTrackChannels ? 'active' : 'inactive'}`}>
          <span className="channel-routing-source-label">File Bus</span>
          <span className="channel-routing-source-value">{formatChannels(trackChannels)}</span>
          <span className="channel-routing-source-sub">
            {!multichannelEnabled
              ? 'Stereo compatibility mode'
              : (currentTrack?.isAtmosJoc ? 'Atmos JOC source' : 'PCM channel map')}
          </span>
        </div>

        <div className="channel-routing-route-list">
          {hasOutputChannels && outputLayout.map((speaker, index) => {
            const sourceIndex = effectiveRouting[index] ?? -1
            const active = sourceIndex >= 0
            const detail = multichannelEnabled
              ? (active ? `From ${getChannelId(sourceIndex, sourceLayout)}` : 'Muted')
              : (active ? 'Auto stereo mix' : 'Inactive in stereo mode')
            return (
              <div
                key={speaker.id}
                className={`channel-routing-route-row ${active ? 'active' : 'inactive'}`}
              >
                <div className={`channel-routing-route-line ${active ? 'active' : ''}`} />
                <div className={`channel-routing-target ${active ? 'active' : ''}`}>
                  <span className="channel-routing-target-id">{speaker.id}</span>
                  <div className="channel-routing-target-text">
                    <span className="channel-routing-target-label">{speaker.label}</span>
                    <span
                      className={`channel-routing-target-detail ${
                        multichannelEnabled ? (active ? 'active' : 'muted') : (active ? 'auto' : 'muted')
                      }`}
                    >
                      {detail}
                    </span>
                  </div>
                  <select
                    className="channel-routing-route-select"
                    value={multichannelEnabled ? sourceIndex : -1}
                    onChange={(event) => handleMappingChange(index, event.target.value)}
                    disabled={!hasTrackChannels || !multichannelEnabled}
                    aria-label={`Route output channel ${speaker.id}`}
                  >
                    <option value={-1}>Mute</option>
                    {sourceOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )
          })}
        </div>

        {!hasOutputChannels && (
          <div className="channel-routing-empty">
            Select an output device to detect available hardware channels.
          </div>
        )}
        {hasOutputChannels && !hasTrackChannels && (
          <div className="channel-routing-empty">
            Play a track to visualize file channel mapping.
          </div>
        )}
        {hasOutputChannels && hasTrackChannels && !multichannelEnabled && (
          <div className="channel-routing-empty">
            Stereo mode is enabled. Turn on multichannel to edit per-channel routing.
          </div>
        )}
      </div>
    </div>
  )
}
