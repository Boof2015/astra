import { useMemo } from 'react'
import {
  BIT_PERFECT_DSP_DISABLED_MESSAGE,
  resolveOutputDeviceLabel,
  useAudioSettingsStore
} from '../../stores/audioSettingsStore'
import { usePlayerStore } from '../../stores/playerStore'
import {
  buildSourceLayout,
  buildSpeakerLayout,
  type ChannelMixInput,
  getSourceChannelId,
  resolveChannelMixMatrix,
} from '../../utils/sourceChannelLayout'

function formatChannels(value: number | null): string {
  if (!value || value <= 0) return '\u2014'
  return `${value}ch`
}

function isUnitySingleSource(row: readonly ChannelMixInput[]): boolean {
  return row.length === 1 && Math.abs(row[0].gain - 1) <= 1e-6
}

export default function ChannelRoutingPanel() {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const {
    selectedDeviceId,
    availableDevices,
    selectedOutputChannelCount,
    multichannelEnabled,
    includeLfeInDownmix,
    playbackOutputMode,
    setMultichannelEnabled,
    setIncludeLfeInDownmix,
    channelRoutingMap,
    setChannelRoutingMap,
    resetChannelRoutingMap,
  } = useAudioSettingsStore()
  const bitPerfectModeActive = playbackOutputMode === 'bitperfect'

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

  const outputLayout = useMemo(
    () => (hasOutputChannels ? buildSpeakerLayout(resolvedOutputChannels) : []),
    [hasOutputChannels, resolvedOutputChannels]
  )

  const sourceLayout = useMemo(
    () => (hasTrackChannels ? buildSourceLayout(resolvedTrackChannels) : []),
    [hasTrackChannels, resolvedTrackChannels]
  )

  const effectiveMixMatrix = useMemo(() => {
    if (!hasOutputChannels || !hasTrackChannels) return []

    return resolveChannelMixMatrix({
      sourceChannels: resolvedTrackChannels,
      outputChannels: resolvedOutputChannels,
      multichannelEnabled,
      manualRoutingMap: channelRoutingMap,
      includeLfeInDownmix,
    })
  }, [
    channelRoutingMap,
    hasOutputChannels,
    hasTrackChannels,
    includeLfeInDownmix,
    multichannelEnabled,
    resolvedOutputChannels,
    resolvedTrackChannels,
  ])

  const mappedChannels = effectiveMixMatrix.reduce((total, row) => (
    row.length > 0 ? total + 1 : total
  ), 0)

  const downmixActive = hasTrackChannels && hasOutputChannels && resolvedTrackChannels > effectiveMixMatrix.length
  const hasManualRouting = Boolean(channelRoutingMap && channelRoutingMap.length > 0)

  const selectedDeviceLabel = resolveOutputDeviceLabel(selectedDeviceId, availableDevices, {
    defaultRouteFallbackLabel: 'System Default Device',
    selectedFallbackLabel: 'Selected Device'
  }).label

  const sourceOptions = useMemo(() => {
    if (!hasTrackChannels) return []
    return sourceLayout.map((channel) => ({
      value: channel.index,
      label: `${channel.id} - ${channel.label}`
    }))
  }, [hasTrackChannels, sourceLayout])

  const formatMixDetail = (row: readonly ChannelMixInput[]): string => {
    if (row.length === 0) return 'Muted'
    if (!multichannelEnabled) return 'Stereo mix'

    const sourceIds = row.map((input) => sourceLayout[input.sourceIndex]?.id ?? getSourceChannelId(input.sourceIndex))
    if (isUnitySingleSource(row)) {
      return `From ${sourceIds[0]}`
    }

    return `Mix ${sourceIds.join(' + ')}`
  }

  const handleMappingChange = (outputIndex: number, rawValue: string) => {
    if (!hasOutputChannels || !hasTrackChannels || !multichannelEnabled) return

    const parsed = Number(rawValue)
    const sourceIndex = Number.isFinite(parsed) ? Math.trunc(parsed) : -1
    const normalizedSourceIndex = sourceIndex >= -1 && sourceIndex < resolvedTrackChannels
      ? sourceIndex
      : -1

    const currentManualMap = channelRoutingMap && channelRoutingMap.length > 0
      ? channelRoutingMap
      : null

    const nextMap = Array.from({ length: resolvedOutputChannels }, (_, index) => (
      index === outputIndex
        ? normalizedSourceIndex
        : (currentManualMap?.[index] ?? (index < resolvedTrackChannels ? index : -1))
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
          onClick={bitPerfectModeActive ? undefined : (() => void setMultichannelEnabled(!multichannelEnabled))}
          disabled={bitPerfectModeActive}
          title={bitPerfectModeActive ? BIT_PERFECT_DSP_DISABLED_MESSAGE : undefined}
        >
          {multichannelEnabled ? 'Multichannel On' : 'Stereo Safe'}
        </button>
        <button
          type="button"
          className={`channel-routing-mode-toggle ${includeLfeInDownmix ? 'active' : ''}`}
          onClick={bitPerfectModeActive ? undefined : (() => void setIncludeLfeInDownmix(!includeLfeInDownmix))}
          disabled={bitPerfectModeActive}
          title={bitPerfectModeActive ? BIT_PERFECT_DSP_DISABLED_MESSAGE : undefined}
        >
          {includeLfeInDownmix ? 'LFE Fold On' : 'LFE Fold Off'}
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
            onClick={bitPerfectModeActive ? undefined : (() => void resetChannelRoutingMap())}
            disabled={bitPerfectModeActive}
            title={bitPerfectModeActive ? BIT_PERFECT_DSP_DISABLED_MESSAGE : undefined}
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
            const row = effectiveMixMatrix[index] ?? []
            const active = row.length > 0
            const sourceIndex = isUnitySingleSource(row) ? row[0].sourceIndex : -1
            const manualSourceIndex = channelRoutingMap?.[index]
            const normalizedManualSourceIndex = (
              hasManualRouting &&
              typeof manualSourceIndex === 'number' &&
              Number.isInteger(manualSourceIndex) &&
              manualSourceIndex >= -1 &&
              manualSourceIndex < resolvedTrackChannels
            )
              ? manualSourceIndex
              : null
            const isAutoMix = active && !isUnitySingleSource(row)
            const detail = active
              ? formatMixDetail(row)
              : (multichannelEnabled ? 'Muted' : 'Inactive in stereo mode')
            const selectValue = multichannelEnabled
              ? (normalizedManualSourceIndex != null
                  ? String(normalizedManualSourceIndex)
                  : (isAutoMix ? 'auto' : String(sourceIndex)))
              : 'auto'
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
                    value={selectValue}
                    onChange={(event) => handleMappingChange(index, event.target.value)}
                    disabled={!hasTrackChannels || !multichannelEnabled || bitPerfectModeActive}
                    title={bitPerfectModeActive ? BIT_PERFECT_DSP_DISABLED_MESSAGE : undefined}
                    aria-label={`Route output channel ${speaker.id}`}
                  >
                    {selectValue === 'auto' && (
                      <option value="auto">Auto mix</option>
                    )}
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
        {bitPerfectModeActive && (
          <div className="channel-routing-empty">
            {BIT_PERFECT_DSP_DISABLED_MESSAGE}
          </div>
        )}
      </div>
    </div>
  )
}
