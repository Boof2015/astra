import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BIT_PERFECT_DSP_DISABLED_MESSAGE,
  resolveOutputDeviceLabel,
  useAudioSettingsStore
} from '../../stores/audioSettingsStore'
import { usePlayerStore } from '../../stores/playerStore'
import {
  buildSourceLayout,
  buildSpeakerLayout,
  canUseStereoAmbientUpmix,
  type ChannelMixInput,
  getSourceChannelId,
  resolveChannelMixMatrix,
  resolveStereoAmbientUpmixPlan,
  type StereoAmbientUpmixRoute,
} from '../../utils/sourceChannelLayout'
import {
  buildVirtualSpeakerLayout,
  getDisplayAzimuthsForLayout,
  isVirtualSpeakerLfe,
  resolveRoutingTargetChannelCount,
  SPATIAL_LAYOUT_PRESETS,
  SPATIAL_MAX_ELEVATION_DEG,
  SPATIAL_MIN_ELEVATION_DEG,
  type SpatialLayoutPresetId,
} from '../../utils/virtualSpeakerLayout'
import { resolveSpeakerStageUsage } from '../../utils/speakerStageUsage'
import SpeakerStage, { type SpeakerStageSpeaker } from './SpeakerStage'

/*
 * The audio pipeline panel: Input → Render → Output.
 *
 * The Render stage owns how channels are transformed and hosts the shared
 * top-down speaker stage. In Direct mode the stage visualizes the physical
 * output layout with click-to-edit routing (the old per-channel list, made
 * visual). In Binaural mode the same stage becomes the Virtual Speaker Room:
 * drag speakers around the listener to reposition them in the headphone
 * render. Binaural is an additional render mode — everything Direct mode does
 * today is unchanged.
 */

function formatChannels(value: number | null): string {
  if (!value || value <= 0) return '—'
  return `${value}ch`
}

function formatHrtfRate(sampleRate: number | null): string {
  if (!sampleRate) return ''
  const khz = sampleRate / 1000
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`
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
    stereoUpmixMode,
    playbackOutputMode,
    setMultichannelEnabled,
    setIncludeLfeInDownmix,
    setStereoUpmixMode,
    channelRoutingMap,
    setChannelRoutingMap,
    resetChannelRoutingMap,
    spatialMode,
    spatialLayoutPresetId,
    customVirtualSpeakers,
    spatialStatus,
    setSpatialMode,
    setSpatialLayoutPreset,
    setVirtualSpeakerAzimuth,
    setVirtualSpeakerElevation,
  } = useAudioSettingsStore()
  const bitPerfectModeActive = playbackOutputMode === 'bitperfect'
  const binauralSelected = spatialMode === 'binaural'
  const binauralActive = binauralSelected && !bitPerfectModeActive && spatialStatus.state === 'ready'

  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string | null>(null)

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

  const virtualSpeakers = useMemo(
    () => buildVirtualSpeakerLayout(spatialLayoutPresetId, customVirtualSpeakers),
    [customVirtualSpeakers, spatialLayoutPresetId]
  )

  const renderTargetChannels = resolveRoutingTargetChannelCount({
    multichannelEnabled,
    binauralActive,
    virtualSpeakerCount: virtualSpeakers.length,
    maxDestinationChannels: hasOutputChannels ? resolvedOutputChannels : 2,
    manualMapLength: channelRoutingMap?.length ?? 0,
    hasSourceChannels: hasTrackChannels,
  })

  // ---- Direct-mode routing math (unchanged behavior) ----

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

  const stereoAmbientUpmixActive = !binauralActive && hasOutputChannels && hasTrackChannels && canUseStereoAmbientUpmix({
    sourceChannels: resolvedTrackChannels,
    outputChannels: resolvedOutputChannels,
    multichannelEnabled,
    standardMode: playbackOutputMode === 'standard',
    stereoUpmixMode,
  })

  const binauralUpmixActive = binauralActive && hasTrackChannels && canUseStereoAmbientUpmix({
    sourceChannels: resolvedTrackChannels,
    outputChannels: renderTargetChannels,
    multichannelEnabled: true,
    standardMode: playbackOutputMode === 'standard',
    stereoUpmixMode,
    outputChannelIds: virtualSpeakers.map((sp) => sp.sourceChannel),
  })

  const virtualSpeakerUsage = useMemo(() => resolveSpeakerStageUsage({
    sourceChannels: hasTrackChannels ? resolvedTrackChannels : null,
    outputChannelIds: virtualSpeakers.map((speaker) => speaker.sourceChannel),
    rendererActive: binauralActive,
    standardMode: playbackOutputMode === 'standard',
    stereoUpmixMode,
    includeLfeInDownmix,
  }), [
    binauralActive,
    hasTrackChannels,
    includeLfeInDownmix,
    playbackOutputMode,
    resolvedTrackChannels,
    stereoUpmixMode,
    virtualSpeakers,
  ])

  const stereoAmbientUpmixRoutes = useMemo(() => {
    if (!stereoAmbientUpmixActive) return new Map<number, StereoAmbientUpmixRoute>()
    return new Map(
      resolveStereoAmbientUpmixPlan(resolvedOutputChannels).routes.map((route) => [route.outputIndex, route])
    )
  }, [resolvedOutputChannels, stereoAmbientUpmixActive])

  const mappedChannels = stereoAmbientUpmixActive
    ? stereoAmbientUpmixRoutes.size
    : effectiveMixMatrix.reduce((total, row) => (
      row.length > 0 ? total + 1 : total
    ), 0)

  const downmixActive = !binauralActive && hasTrackChannels && hasOutputChannels && resolvedTrackChannels > effectiveMixMatrix.length
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

  const formatMixDetail = useCallback((row: readonly ChannelMixInput[]): string => {
    if (row.length === 0) return 'Muted'
    if (!multichannelEnabled) return 'Stereo mix'

    const sourceIds = row.map((input) => sourceLayout[input.sourceIndex]?.id ?? getSourceChannelId(input.sourceIndex))
    if (isUnitySingleSource(row)) {
      return `From ${sourceIds[0]}`
    }

    return `Mix ${sourceIds.join(' + ')}`
  }, [multichannelEnabled, sourceLayout])

  const formatUpmixDetail = useCallback((route: StereoAmbientUpmixRoute): string => {
    if (route.kind === 'direct') {
      const sourceId = route.inputs[0]
        ? (sourceLayout[route.inputs[0].sourceIndex]?.id ?? getSourceChannelId(route.inputs[0].sourceIndex))
        : 'Stereo'
      return `From ${sourceId}`
    }

    return route.outputId.endsWith('R') ? 'Side ambience R' : 'Side ambience L'
  }, [sourceLayout])

  const handleMappingChange = (outputIndex: number, rawValue: string) => {
    if (!hasOutputChannels || !hasTrackChannels || !multichannelEnabled || stereoAmbientUpmixActive) return

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

  // ---- Direct-mode per-channel route facts (drives stage + detail card) ----

  interface DirectRoute {
    speakerId: string
    channelId: string
    label: string
    active: boolean
    detail: string
    selectValue: string
    selectDisabled: boolean
    outputIndex: number
  }

  const directRoutes = useMemo<DirectRoute[]>(() => {
    if (!hasOutputChannels) return []
    return outputLayout.map((speaker, index) => {
      const upmixRoute = stereoAmbientUpmixRoutes.get(index) ?? null
      const row = effectiveMixMatrix[index] ?? []
      const active = upmixRoute ? true : row.length > 0
      const sourceIndex = upmixRoute?.kind === 'direct'
        ? (upmixRoute.inputs[0]?.sourceIndex ?? -1)
        : (isUnitySingleSource(row) ? row[0].sourceIndex : -1)
      const manualSourceIndex = channelRoutingMap?.[index]
      const normalizedManualSourceIndex = (
        !stereoAmbientUpmixActive &&
        hasManualRouting &&
        typeof manualSourceIndex === 'number' &&
        Number.isInteger(manualSourceIndex) &&
        manualSourceIndex >= -1 &&
        manualSourceIndex < resolvedTrackChannels
      )
        ? manualSourceIndex
        : null
      const isAutoMix = upmixRoute?.kind === 'ambience' || (active && !upmixRoute && !isUnitySingleSource(row))
      const detail = active
        ? (upmixRoute ? formatUpmixDetail(upmixRoute) : formatMixDetail(row))
        : (multichannelEnabled ? 'Muted' : 'Inactive in stereo mode')
      const selectValue = stereoAmbientUpmixActive
        ? (upmixRoute ? 'upmix' : '-1')
        : multichannelEnabled
        ? (normalizedManualSourceIndex != null
            ? String(normalizedManualSourceIndex)
            : (isAutoMix ? 'auto' : String(sourceIndex)))
        : 'auto'
      const selectDisabled = (
        !hasTrackChannels ||
        !multichannelEnabled ||
        bitPerfectModeActive ||
        stereoAmbientUpmixActive
      )
      return {
        speakerId: speaker.id,
        channelId: speaker.id,
        label: speaker.label,
        active,
        detail,
        selectValue,
        selectDisabled,
        outputIndex: index,
      }
    })
  }, [
    bitPerfectModeActive,
    channelRoutingMap,
    effectiveMixMatrix,
    formatMixDetail,
    formatUpmixDetail,
    hasManualRouting,
    hasOutputChannels,
    hasTrackChannels,
    multichannelEnabled,
    outputLayout,
    resolvedTrackChannels,
    stereoAmbientUpmixActive,
    stereoAmbientUpmixRoutes,
  ])

  // ---- Stage speakers for both modes ----

  const directDisplayAzimuths = useMemo(
    () => getDisplayAzimuthsForLayout(outputLayout.map((speaker) => speaker.id)),
    [outputLayout]
  )

  const stageSpeakers = useMemo<SpeakerStageSpeaker[]>(() => {
    if (binauralSelected) {
      return virtualSpeakers.map((sp, index) => ({
        id: sp.id,
        channelId: sp.sourceChannel,
        label: `${sp.sourceChannel} virtual speaker`,
        azimuth: isVirtualSpeakerLfe(sp) ? null : sp.azimuth,
        elevation: isVirtualSpeakerLfe(sp) ? undefined : sp.elevation,
        state: virtualSpeakerUsage[index] ?? 'inactive',
        draggable: !isVirtualSpeakerLfe(sp),
      }))
    }
    return directRoutes.map((route, index) => ({
      id: route.speakerId,
      channelId: route.channelId,
      label: route.label,
      azimuth: directDisplayAzimuths[index] ?? null,
      state: route.active ? 'routed' as const : (hasTrackChannels ? 'unused' as const : 'inactive' as const),
      draggable: false,
    }))
  }, [binauralSelected, directDisplayAzimuths, directRoutes, hasTrackChannels, virtualSpeakers, virtualSpeakerUsage])

  // Selection carries no meaning across mode/layout switches.
  useEffect(() => {
    setSelectedSpeakerId(null)
  }, [binauralSelected, spatialLayoutPresetId, resolvedOutputChannels])

  const selectedDirectRoute = !binauralSelected
    ? directRoutes.find((route) => route.speakerId === selectedSpeakerId) ?? null
    : null
  const selectedVirtualSpeaker = binauralSelected
    ? virtualSpeakers.find((sp) => sp.id === selectedSpeakerId) ?? null
    : null

  // ---- Virtual Speaker Room drag plumbing (rAF-throttled engine pushes) ----

  const dragFrameRef = useRef<number | null>(null)
  const pendingDragRef = useRef<{ speakerId: string; azimuthDeg: number } | null>(null)

  const handleSpeakerAzimuthChange = useCallback((speakerId: string, azimuthDeg: number) => {
    pendingDragRef.current = { speakerId, azimuthDeg }
    if (dragFrameRef.current !== null) return
    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = null
      const pending = pendingDragRef.current
      pendingDragRef.current = null
      if (pending) {
        void setVirtualSpeakerAzimuth(pending.speakerId, pending.azimuthDeg)
      }
    })
  }, [setVirtualSpeakerAzimuth])

  const elevationFrameRef = useRef<number | null>(null)
  const pendingElevationRef = useRef<{ speakerId: string; elevationDeg: number } | null>(null)

  const handleSpeakerElevationChange = useCallback((speakerId: string, elevationDeg: number) => {
    pendingElevationRef.current = { speakerId, elevationDeg }
    if (elevationFrameRef.current !== null) return
    elevationFrameRef.current = requestAnimationFrame(() => {
      elevationFrameRef.current = null
      const pending = pendingElevationRef.current
      pendingElevationRef.current = null
      if (pending) {
        void setVirtualSpeakerElevation(pending.speakerId, pending.elevationDeg)
      }
    })
  }, [setVirtualSpeakerElevation])

  useEffect(() => () => {
    if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current)
    if (elevationFrameRef.current !== null) cancelAnimationFrame(elevationFrameRef.current)
  }, [])

  // ---- Render helpers ----

  const disabledTitle = bitPerfectModeActive ? BIT_PERFECT_DSP_DISABLED_MESSAGE : undefined

  const spatialNotice = binauralSelected && (spatialStatus.state === 'error' || spatialStatus.state === 'unsupported-samplerate')
    ? (spatialStatus.message ?? 'The binaural renderer is unavailable; playback falls back to Direct rendering.')
    : null

  const inputSummary = hasTrackChannels
    ? `${formatChannels(trackChannels)}${currentTrack?.isAtmosJoc ? ' · Atmos JOC' : ''}${currentTrack?.isIamf ? ' · Eclipsa' : ''}`
    : 'No track playing'

  const renderSummary = binauralSelected
    ? `${renderTargetChannels}ch → 2ch binaural`
    : (multichannelEnabled ? `${Math.max(renderTargetChannels, 0)}ch direct` : 'Stereo safe')

  return (
    <div className="pipeline-panel">
      {/* ---- Input ---- */}
      <div className="pipeline-card">
        <div className="pipeline-card-head">
          <span className="pipeline-card-step">Input</span>
          <span className="pipeline-card-summary">{inputSummary}</span>
        </div>
        {hasTrackChannels ? (
          <div className="pipeline-chip-row">
            {sourceLayout.map((channel) => (
              <span key={channel.id} className="pipeline-chip" title={channel.label}>
                {channel.id}
              </span>
            ))}
            {currentTrack?.isAtmosJoc && (
              <span className="pipeline-chip pipeline-chip-accent" title="Dolby Atmos (Joint Object Coding) source">
                Atmos JOC
              </span>
            )}
            {currentTrack?.isIamf && (
              <span className="pipeline-chip pipeline-chip-accent" title="Eclipsa Audio (IAMF) source, rendered to 7.1.4">
                Eclipsa
              </span>
            )}
          </div>
        ) : (
          <p className="pipeline-note">Play a track to see its channel layout.</p>
        )}
      </div>

      <div className="pipeline-flow" aria-hidden>
        <span className="pipeline-flow-line" />
      </div>

      {/* ---- Render ---- */}
      <div className="pipeline-card">
        <div className="pipeline-card-head">
          <span className="pipeline-card-step">Render</span>
          <div className="pipeline-mode-toggle" role="tablist" aria-label="Render mode">
            <button
              type="button"
              role="tab"
              aria-selected={!binauralSelected}
              className={`pipeline-mode-btn ${!binauralSelected ? 'active' : ''}`}
              onClick={bitPerfectModeActive || !binauralSelected ? undefined : (() => void setSpatialMode('off'))}
              disabled={bitPerfectModeActive}
              title={disabledTitle}
            >
              Direct
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={binauralSelected}
              className={`pipeline-mode-btn ${binauralSelected ? 'active' : ''}`}
              onClick={bitPerfectModeActive || binauralSelected ? undefined : (() => void setSpatialMode('binaural'))}
              disabled={bitPerfectModeActive}
              title={disabledTitle ?? 'Render multichannel audio to headphones with virtual speakers (HRTF)'}
            >
              Binaural
            </button>
          </div>
          <span className="pipeline-card-summary">{renderSummary}</span>
        </div>

        {/* Mode controls */}
        {!binauralSelected ? (
          <div className="pipeline-control-row">
            <button
              type="button"
              className={`pipeline-toggle ${multichannelEnabled ? 'active' : ''}`}
              onClick={bitPerfectModeActive ? undefined : (() => void setMultichannelEnabled(!multichannelEnabled))}
              disabled={bitPerfectModeActive}
              title={disabledTitle}
            >
              {multichannelEnabled ? 'Multichannel On' : 'Stereo Safe'}
            </button>
            <button
              type="button"
              className={`pipeline-toggle ${includeLfeInDownmix ? 'active' : ''}`}
              onClick={bitPerfectModeActive ? undefined : (() => void setIncludeLfeInDownmix(!includeLfeInDownmix))}
              disabled={bitPerfectModeActive}
              title={disabledTitle}
            >
              {includeLfeInDownmix ? 'LFE Fold On' : 'LFE Fold Off'}
            </button>
            <button
              type="button"
              className={`pipeline-toggle ${stereoUpmixMode === 'ambient' ? 'active' : ''}`}
              onClick={bitPerfectModeActive ? undefined : (() => void setStereoUpmixMode(stereoUpmixMode === 'ambient' ? 'off' : 'ambient'))}
              disabled={bitPerfectModeActive}
              title={disabledTitle}
            >
              {stereoUpmixMode === 'ambient' ? 'Ambient Upmix On' : 'Ambient Upmix Off'}
            </button>
          </div>
        ) : (
          <div className="pipeline-control-row">
            <label className="pipeline-select-label">
              Layout
              <select
                className="pipeline-select"
                value={spatialLayoutPresetId}
                onChange={(event) => void setSpatialLayoutPreset(event.target.value as SpatialLayoutPresetId)}
                disabled={bitPerfectModeActive}
                title={disabledTitle}
              >
                {SPATIAL_LAYOUT_PRESETS.map((preset) => (
                  <option
                    key={preset.id}
                    value={preset.id}
                    disabled={preset.id === 'custom' && !customVirtualSpeakers}
                  >
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={`pipeline-toggle ${stereoUpmixMode === 'ambient' ? 'active' : ''}`}
              onClick={bitPerfectModeActive ? undefined : (() => void setStereoUpmixMode(stereoUpmixMode === 'ambient' ? 'off' : 'ambient'))}
              disabled={bitPerfectModeActive}
              title={disabledTitle ?? 'Upmix stereo tracks into the virtual speaker layout'}
            >
              {stereoUpmixMode === 'ambient' ? 'Ambient Upmix On' : 'Ambient Upmix Off'}
            </button>
          </div>
        )}

        {/* Status chips */}
        <div className="pipeline-chip-row">
          {!binauralSelected && hasOutputChannels && (
            <span className="pipeline-chip">Mapped {mappedChannels}/{formatChannels(outputChannels)}</span>
          )}
          {stereoAmbientUpmixActive && (
            <span className="pipeline-chip pipeline-chip-accent">Upmix Active</span>
          )}
          {binauralUpmixActive && (
            <span className="pipeline-chip pipeline-chip-accent">Upmix Active</span>
          )}
          {!binauralSelected && hasManualRouting && multichannelEnabled && !stereoAmbientUpmixActive && (
            <span className="pipeline-chip pipeline-chip-accent">Remap Active</span>
          )}
          {!binauralSelected && hasManualRouting && !multichannelEnabled && (
            <span className="pipeline-chip">Remap Saved</span>
          )}
          {binauralSelected && spatialStatus.state === 'ready' && (
            <span className="pipeline-chip" title="Head-related transfer function (MIT KEMAR)">
              HRTF {formatHrtfRate(spatialStatus.sampleRate)}
            </span>
          )}
          {binauralSelected && spatialStatus.state === 'loading' && (
            <span className="pipeline-chip">Loading renderer…</span>
          )}
          {spatialNotice && (
            <span className="pipeline-chip pipeline-chip-warning" title={spatialNotice}>
              Renderer unavailable
            </span>
          )}
          {!binauralSelected && hasManualRouting && !stereoAmbientUpmixActive && (
            <button
              type="button"
              className="pipeline-reset-btn"
              onClick={bitPerfectModeActive ? undefined : (() => void resetChannelRoutingMap())}
              disabled={bitPerfectModeActive}
              title={disabledTitle}
            >
              Reset Routing
            </button>
          )}
        </div>

        {spatialNotice && (
          <p className="pipeline-note pipeline-note-warning">{spatialNotice}</p>
        )}

        {/* The stage */}
        {(binauralSelected || hasOutputChannels) && (
          <SpeakerStage
            speakers={stageSpeakers}
            selectedId={selectedSpeakerId}
            onSelect={setSelectedSpeakerId}
            onAzimuthChange={binauralSelected ? handleSpeakerAzimuthChange : undefined}
            disabled={bitPerfectModeActive}
            disabledTitle={disabledTitle}
          />
        )}
        {!binauralSelected && !hasOutputChannels && (
          <p className="pipeline-note">Select an output device to detect available hardware channels.</p>
        )}

        {/* Detail card for the selected speaker */}
        {selectedDirectRoute && (
          <div className="pipeline-detail-card">
            <div className="pipeline-detail-text">
              <span className="pipeline-detail-title">
                {selectedDirectRoute.channelId} · {selectedDirectRoute.label}
              </span>
              <span className="pipeline-detail-sub">{selectedDirectRoute.detail}</span>
            </div>
            <select
              className="pipeline-select"
              value={selectedDirectRoute.selectValue}
              onChange={(event) => handleMappingChange(selectedDirectRoute.outputIndex, event.target.value)}
              disabled={selectedDirectRoute.selectDisabled}
              title={disabledTitle}
              aria-label={`Route output channel ${selectedDirectRoute.channelId}`}
            >
              {selectedDirectRoute.selectValue === 'upmix' && (
                <option value="upmix">Generated upmix</option>
              )}
              {selectedDirectRoute.selectValue === 'auto' && (
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
        )}
        {selectedVirtualSpeaker && (
          <div className="pipeline-detail-card">
            <div className="pipeline-detail-text">
              <span className="pipeline-detail-title">
                {selectedVirtualSpeaker.sourceChannel} virtual speaker
              </span>
              <span className="pipeline-detail-sub">
                {isVirtualSpeakerLfe(selectedVirtualSpeaker)
                  ? 'Non-positional — mixed equally into both ears'
                  : `${Math.round(selectedVirtualSpeaker.azimuth)}° · drag to reposition, Shift for 5° steps`}
              </span>
            </div>
            {!isVirtualSpeakerLfe(selectedVirtualSpeaker) && (
              <label className="pipeline-elevation-control" title={disabledTitle}>
                <span className="pipeline-detail-sub">
                  Elevation {Math.round(selectedVirtualSpeaker.elevation)}°
                </span>
                <input
                  type="range"
                  min={SPATIAL_MIN_ELEVATION_DEG}
                  max={SPATIAL_MAX_ELEVATION_DEG}
                  step={1}
                  value={Math.round(selectedVirtualSpeaker.elevation)}
                  onChange={(event) => handleSpeakerElevationChange(
                    selectedVirtualSpeaker.id,
                    Number(event.target.value)
                  )}
                  disabled={bitPerfectModeActive}
                  aria-label={`${selectedVirtualSpeaker.sourceChannel} elevation in degrees`}
                />
              </label>
            )}
          </div>
        )}

        {/* Contextual notes (mirror the old empty states) */}
        {!binauralSelected && hasOutputChannels && !hasTrackChannels && (
          <p className="pipeline-note">Play a track to visualize file channel mapping.</p>
        )}
        {!binauralSelected && hasOutputChannels && hasTrackChannels && !multichannelEnabled && (
          <p className="pipeline-note">Stereo mode is enabled. Turn on multichannel to edit per-channel routing.</p>
        )}
        {binauralSelected && !bitPerfectModeActive && (
          <p className="pipeline-note">
            Virtual Speaker Room — drag speakers around the listener to shape the headphone render.
            {stereoUpmixMode !== 'ambient' && hasTrackChannels && resolvedTrackChannels === 2 && virtualSpeakers.length > 2
              ? ' Enable Ambient Upmix to fill the surround speakers from stereo tracks.'
              : ''}
          </p>
        )}
        {bitPerfectModeActive && (
          <p className="pipeline-note">{BIT_PERFECT_DSP_DISABLED_MESSAGE}</p>
        )}
      </div>

      <div className="pipeline-flow" aria-hidden>
        <span className="pipeline-flow-line" />
      </div>

      {/* ---- Output ---- */}
      <div className="pipeline-card">
        <div className="pipeline-card-head">
          <span className="pipeline-card-step">Output</span>
          <span className="pipeline-card-summary">
            {binauralActive ? '2ch stereo (binaural)' : formatChannels(hasOutputChannels ? effectiveOutputChannels : null)}
          </span>
        </div>
        <div className="pipeline-chip-row">
          <span className="pipeline-chip pipeline-chip-device" title={selectedDeviceLabel}>
            {selectedDeviceLabel}
          </span>
          {hasOutputChannels && (
            <span className="pipeline-chip">Device {formatChannels(outputChannels)}</span>
          )}
          {downmixActive && (
            <span className="pipeline-chip pipeline-chip-warning">
              Downmix {resolvedTrackChannels}{'->'}{effectiveOutputChannels}
            </span>
          )}
          {bitPerfectModeActive && (
            <span className="pipeline-chip pipeline-chip-accent">Bit-perfect</span>
          )}
        </div>
        {binauralActive && (
          <p className="pipeline-note">
            Binaural rendering outputs stereo for headphones; the physical channel layout is not used.
          </p>
        )}
      </div>
    </div>
  )
}
