import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BIT_PERFECT_DSP_DISABLED_MESSAGE,
  resolveOutputDeviceLabel,
  useAudioSettingsStore
} from '../../stores/audioSettingsStore'
import { usePlayerStore } from '../../stores/playerStore'
import {
  applySourceSpeakerOverridesToStereoAmbientUpmixPlan,
  buildSourceLayout,
  buildSpeakerLayoutFromIds,
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
  SPATIAL_LAYOUT_PRESETS,
  SPATIAL_MAX_ELEVATION_DEG,
  SPATIAL_MIN_ELEVATION_DEG,
  type SpatialLayoutPresetId,
} from '../../utils/virtualSpeakerLayout'
import {
  SPEAKER_LAYOUT_PRESETS,
  buildSpeakerHardwareRoutingPlan,
  getSpeakerLayoutDefinition,
  resolveDirectSpeakerIds,
  type SpeakerLayoutPresetId,
  type SpeakerRoleId,
} from '../../utils/speakerLayout'
import { resolveSpeakerStageUsage } from '../../utils/speakerStageUsage'
import SpeakerStage, { type SpeakerStageSpeaker } from './SpeakerStage'
import SettingsSegmentedControl from './SettingsSegmentedControl'

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

const OFF_ON_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
] as const

export default function ChannelRoutingPanel() {
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const {
    selectedDeviceId,
    availableDevices,
    selectedDeviceMaxChannelCount,
    logicalOutputChannelCount,
    multichannelEnabled,
    includeLfeInDownmix,
    stereoUpmixMode,
    playbackOutputMode,
    nativeAudioOutputStatus,
    setMultichannelEnabled,
    setIncludeLfeInDownmix,
    setStereoUpmixMode,
    sourceSpeakerRoutingMap,
    setSourceSpeakerRoute,
    resetSourceSpeakerRouting,
    activeSpeakerProfile,
    setSpeakerLayout,
    setSpeakerHardwareOutput,
    resetSpeakerProfile,
    testingSpeakerRole,
    playSpeakerTestTone,
    spatialMode,
    spatialLayoutPresetId,
    customVirtualSpeakers,
    spatialStatus,
    hrtfProfiles,
    selectedHrtfProfileId,
    hrtfProfileError,
    hrtfImporting,
    setSpatialMode,
    setHrtfProfile,
    importHrtfProfile,
    removeHrtfProfile,
    setSpatialLayoutPreset,
    setVirtualSpeakerAzimuth,
    setVirtualSpeakerElevation,
  } = useAudioSettingsStore()
  const bitPerfectModeActive = playbackOutputMode !== 'standard'
  const bitPerfectVerifiedActive = playbackOutputMode === 'bitperfect' && Boolean(nativeAudioOutputStatus?.bitPerfectActive)
  const nativeRoutingDisabledMessage = playbackOutputMode === 'bitperfect'
    ? BIT_PERFECT_DSP_DISABLED_MESSAGE
    : 'Channel routing, upmix/downmix, and spatial rendering are Standard-only. Exclusive DSP preserves the source channel layout.'
  const binauralSelected = spatialMode === 'binaural'
  const binauralActive = binauralSelected && !bitPerfectModeActive && spatialStatus.state === 'ready'
  const hrtfSwitching = spatialStatus.switchingProfileId !== null
  const hrtfBusy = hrtfSwitching || hrtfImporting
  const selectedHrtfProfile = hrtfProfiles.find((profile) => profile.id === selectedHrtfProfileId) ?? hrtfProfiles[0]

  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string | null>(null)

  const trackChannels = currentTrack?.channels ?? null
  const deviceMaxChannels = selectedDeviceMaxChannelCount && selectedDeviceMaxChannelCount > 0
    ? selectedDeviceMaxChannelCount
    : null

  const hasTrackChannels = Boolean(trackChannels && trackChannels > 0)
  const hasOutputChannels = Boolean(deviceMaxChannels && deviceMaxChannels > 0)
  const resolvedTrackChannels = hasTrackChannels ? (trackChannels as number) : 0
  const resolvedDeviceMaxChannels = hasOutputChannels ? (deviceMaxChannels as number) : 0
  const physicalSpeakerIds = getSpeakerLayoutDefinition(activeSpeakerProfile.layoutId).speakers
  const directOutputIds = resolveDirectSpeakerIds(activeSpeakerProfile, multichannelEnabled)
  const effectiveOutputChannels = logicalOutputChannelCount
  const hardwareRoutingPlan = buildSpeakerHardwareRoutingPlan(activeSpeakerProfile)

  const outputLayout = useMemo(
    () => buildSpeakerLayoutFromIds(physicalSpeakerIds),
    [physicalSpeakerIds]
  )

  const sourceLayout = useMemo(
    () => (hasTrackChannels ? buildSourceLayout(resolvedTrackChannels) : []),
    [hasTrackChannels, resolvedTrackChannels]
  )

  const virtualSpeakers = useMemo(
    () => buildVirtualSpeakerLayout(spatialLayoutPresetId, customVirtualSpeakers),
    [customVirtualSpeakers, spatialLayoutPresetId]
  )

  const renderTargetChannels = binauralActive
    ? Math.max(1, virtualSpeakers.length)
    : Math.max(1, directOutputIds.length)

  // ---- Direct-mode logical speaker routing ----

  const effectiveMixMatrix = useMemo(() => {
    if (!hasTrackChannels) return []

    return resolveChannelMixMatrix({
      sourceChannels: resolvedTrackChannels,
      outputChannels: directOutputIds.length,
      multichannelEnabled,
      sourceSpeakerRoutingMap: multichannelEnabled ? sourceSpeakerRoutingMap : null,
      includeLfeInDownmix,
      outputChannelIds: directOutputIds,
    })
  }, [
    directOutputIds,
    hasTrackChannels,
    includeLfeInDownmix,
    multichannelEnabled,
    resolvedTrackChannels,
    sourceSpeakerRoutingMap,
  ])

  const stereoAmbientUpmixActive = !binauralActive && hasTrackChannels && canUseStereoAmbientUpmix({
    sourceChannels: resolvedTrackChannels,
    outputChannels: directOutputIds.length,
    multichannelEnabled,
    standardMode: playbackOutputMode === 'standard',
    stereoUpmixMode,
    outputChannelIds: directOutputIds,
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
      applySourceSpeakerOverridesToStereoAmbientUpmixPlan(
        resolveStereoAmbientUpmixPlan(directOutputIds.length, directOutputIds),
        sourceSpeakerRoutingMap,
        directOutputIds
      )
        .routes.map((route) => [route.outputIndex, route])
    )
  }, [directOutputIds, sourceSpeakerRoutingMap, stereoAmbientUpmixActive])

  const mappedChannels = stereoAmbientUpmixActive
    ? stereoAmbientUpmixRoutes.size
    : effectiveMixMatrix.reduce((total, row) => (
      row.length > 0 ? total + 1 : total
    ), 0)

  const downmixActive = !binauralActive && hasTrackChannels && resolvedTrackChannels > effectiveMixMatrix.length
  const hasManualRouting = Object.keys(sourceSpeakerRoutingMap).length > 0

  const selectedDeviceLabel = resolveOutputDeviceLabel(selectedDeviceId, availableDevices, {
    defaultRouteFallbackLabel: 'System Default Device',
    selectedFallbackLabel: 'Selected Device'
  }).label

  const sourceOptions = useMemo(() => {
    if (!hasTrackChannels) return []
    return sourceLayout.map((channel) => ({
      value: channel.id,
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

  const handleSourceRouteChange = (speaker: SpeakerRoleId, rawValue: string) => {
    if (!hasTrackChannels || !multichannelEnabled) return
    if (rawValue === 'auto') {
      void setSourceSpeakerRoute(speaker, null)
    } else if (rawValue === 'mute') {
      void setSourceSpeakerRoute(speaker, { kind: 'mute' })
    } else if (rawValue.startsWith('source:')) {
      void setSourceSpeakerRoute(speaker, {
        kind: 'source',
        sourceChannelId: rawValue.slice('source:'.length),
      })
    }
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
    speakerRole: SpeakerRoleId
  }

  const directRoutes = useMemo<DirectRoute[]>(() => {
    return outputLayout.map((speaker) => {
      const speakerRole = speaker.id as SpeakerRoleId
      const effectiveIndex = directOutputIds.indexOf(speakerRole)
      const upmixRoute = effectiveIndex >= 0
        ? (stereoAmbientUpmixRoutes.get(effectiveIndex) ?? null)
        : null
      const row = effectiveIndex >= 0 ? (effectiveMixMatrix[effectiveIndex] ?? []) : []
      const active = upmixRoute ? true : row.length > 0
      const sourceOverride = sourceSpeakerRoutingMap[speakerRole]
      const detail = effectiveIndex < 0
        ? 'Inactive while Multichannel is Off'
        : sourceOverride?.kind === 'source' && row.length === 0
          ? `Source ${sourceOverride.sourceChannelId} unavailable`
          : active
            ? (upmixRoute ? formatUpmixDetail(upmixRoute) : formatMixDetail(row))
            : 'Muted'
      const selectValue = sourceOverride?.kind === 'mute'
          ? 'mute'
          : sourceOverride?.kind === 'source'
            ? `source:${sourceOverride.sourceChannelId}`
            : 'auto'
      const selectDisabled = (
        !hasTrackChannels ||
        !multichannelEnabled ||
        bitPerfectModeActive
      )
      return {
        speakerId: speaker.id,
        channelId: speaker.id,
        label: speaker.label,
        active,
        detail,
        selectValue,
        selectDisabled,
        speakerRole,
      }
    })
  }, [
    bitPerfectModeActive,
    directOutputIds,
    effectiveMixMatrix,
    formatMixDetail,
    formatUpmixDetail,
    hasTrackChannels,
    multichannelEnabled,
    outputLayout,
    sourceSpeakerRoutingMap,
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
  }, [activeSpeakerProfile.layoutId, binauralSelected, spatialLayoutPresetId])

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

  const disabledTitle = bitPerfectModeActive ? nativeRoutingDisabledMessage : undefined

  const handleRemoveHrtfProfile = useCallback(() => {
    if (!selectedHrtfProfile || selectedHrtfProfile.kind === 'builtin') return
    if (!window.confirm(`Remove “${selectedHrtfProfile.name}” from Astra’s HRTF library? The managed copy will be moved to Trash.`)) return
    void removeHrtfProfile(selectedHrtfProfile.id)
  }, [removeHrtfProfile, selectedHrtfProfile])

  const spatialNotice = binauralSelected && (spatialStatus.state === 'error' || spatialStatus.state === 'unsupported-samplerate')
    ? (spatialStatus.message ?? 'The binaural renderer is unavailable; playback falls back to Direct rendering.')
    : null

  const inputSummary = hasTrackChannels
    ? `${formatChannels(trackChannels)}${currentTrack?.isAtmosJoc ? ' · Atmos JOC' : ''}${currentTrack?.isIamf ? ' · Eclipsa' : ''}`
    : 'No track playing'

  const renderSummary = binauralSelected
    ? `${renderTargetChannels}ch → 2ch binaural`
    : `${Math.max(renderTargetChannels, 1)}ch logical direct`

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
          <div className="pipeline-setting-list">
            <div className="pipeline-setting-row">
              <div className="pipeline-setting-copy">
                <span className="pipeline-setting-title">Multichannel</span>
                <span className="pipeline-setting-description">Use the complete configured speaker layout.</span>
              </div>
              <SettingsSegmentedControl
                ariaLabel="Multichannel output"
                disabled={bitPerfectModeActive}
                options={OFF_ON_OPTIONS}
                value={multichannelEnabled ? 'on' : 'off'}
                onChange={(value) => void setMultichannelEnabled(value === 'on')}
              />
            </div>
            <div className="pipeline-setting-row">
              <div className="pipeline-setting-copy">
                <span className="pipeline-setting-title">LFE Fold-down</span>
                <span className="pipeline-setting-description">Include LFE content when the logical layout has no subwoofer.</span>
              </div>
              <SettingsSegmentedControl
                ariaLabel="LFE fold-down"
                disabled={bitPerfectModeActive}
                options={OFF_ON_OPTIONS}
                value={includeLfeInDownmix ? 'on' : 'off'}
                onChange={(value) => void setIncludeLfeInDownmix(value === 'on')}
              />
            </div>
            <div className="pipeline-setting-row">
              <div className="pipeline-setting-copy">
                <span className="pipeline-setting-title">Ambient Upmix</span>
                <span className="pipeline-setting-description">Generate decorrelated surround ambience from stereo tracks.</span>
              </div>
              <SettingsSegmentedControl
                ariaLabel="Ambient stereo upmix"
                disabled={bitPerfectModeActive}
                options={OFF_ON_OPTIONS}
                value={stereoUpmixMode === 'ambient' ? 'on' : 'off'}
                onChange={(value) => void setStereoUpmixMode(value === 'on' ? 'ambient' : 'off')}
              />
            </div>
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
            <label className="pipeline-select-label">
              HRTF
              <select
                className="pipeline-select"
                value={selectedHrtfProfileId}
                onChange={(event) => void setHrtfProfile(event.target.value)}
                disabled={bitPerfectModeActive || hrtfBusy}
                title={disabledTitle ?? 'Head-related transfer function profile'}
              >
                {hrtfProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}{profile.kind === 'builtin' ? ' — Built-in' : ''}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="pipeline-toggle"
              onClick={bitPerfectModeActive || hrtfBusy ? undefined : (() => void importHrtfProfile())}
              disabled={bitPerfectModeActive || hrtfBusy}
              title={disabledTitle ?? 'Import an AES69 SOFA HRTF profile'}
            >
              {hrtfImporting ? 'Validating…' : 'Import SOFA'}
            </button>
            {selectedHrtfProfile?.kind === 'sofa' && (
              <button
                type="button"
                className="pipeline-reset-btn"
                onClick={bitPerfectModeActive || hrtfBusy ? undefined : handleRemoveHrtfProfile}
                disabled={bitPerfectModeActive || hrtfBusy}
                title={disabledTitle ?? 'Remove this imported HRTF profile'}
              >
                Remove
              </button>
            )}
          </div>
        )}

        {binauralSelected && (
          <div className="pipeline-setting-row">
            <div className="pipeline-setting-copy">
              <span className="pipeline-setting-title">Ambient Upmix</span>
              <span className="pipeline-setting-description">Fill the virtual surround room from stereo tracks.</span>
            </div>
            <SettingsSegmentedControl
              ariaLabel="Binaural ambient stereo upmix"
              disabled={bitPerfectModeActive}
              options={OFF_ON_OPTIONS}
              value={stereoUpmixMode === 'ambient' ? 'on' : 'off'}
              onChange={(value) => void setStereoUpmixMode(value === 'on' ? 'ambient' : 'off')}
            />
          </div>
        )}

        {/* Status chips */}
        <div className="pipeline-chip-row">
          {!binauralSelected && (
            <span className="pipeline-chip">Routed {mappedChannels}/{directOutputIds.length} speakers</span>
          )}
          {stereoAmbientUpmixActive && (
            <span className="pipeline-chip pipeline-chip-accent">Upmix Active</span>
          )}
          {binauralUpmixActive && (
            <span className="pipeline-chip pipeline-chip-accent">Upmix Active</span>
          )}
          {!binauralSelected && hasManualRouting && multichannelEnabled && (
            <span className="pipeline-chip pipeline-chip-accent">Remap Active</span>
          )}
          {!binauralSelected && hasManualRouting && !multichannelEnabled && (
            <span className="pipeline-chip">Remap Saved</span>
          )}
          {binauralSelected && spatialStatus.state === 'ready' && (
            <span className="pipeline-chip" title={`Head-related transfer function (${spatialStatus.profileName})`}>
              HRTF {spatialStatus.profileName} · {formatHrtfRate(spatialStatus.sampleRate)}
            </span>
          )}
          {binauralSelected && (spatialStatus.state === 'loading' || hrtfBusy) && (
            <span className="pipeline-chip">
              {hrtfImporting ? 'Validating SOFA…' : hrtfSwitching ? 'Switching HRTF…' : 'Loading renderer…'}
            </span>
          )}
          {spatialNotice && (
            <span className="pipeline-chip pipeline-chip-warning" title={spatialNotice}>
              Renderer unavailable
            </span>
          )}
          {!binauralSelected && hasManualRouting && (
            <button
              type="button"
              className="pipeline-reset-btn"
              onClick={bitPerfectModeActive ? undefined : (() => void resetSourceSpeakerRouting())}
              disabled={bitPerfectModeActive}
              title={disabledTitle}
            >
              Reset Source Routing
            </button>
          )}
        </div>

        {spatialNotice && (
          <p className="pipeline-note pipeline-note-warning">{spatialNotice}</p>
        )}
        {binauralSelected && hrtfProfileError && (
          <p className="pipeline-note pipeline-note-warning">{hrtfProfileError.message}</p>
        )}

        {/* The stage */}
        {(binauralSelected || outputLayout.length > 0) && (
          <SpeakerStage
            speakers={stageSpeakers}
            selectedId={selectedSpeakerId}
            onSelect={setSelectedSpeakerId}
            onAzimuthChange={binauralSelected ? handleSpeakerAzimuthChange : undefined}
            disabled={bitPerfectModeActive}
            disabledTitle={disabledTitle}
          />
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
              onChange={(event) => handleSourceRouteChange(selectedDirectRoute.speakerRole, event.target.value)}
              disabled={selectedDirectRoute.selectDisabled}
              title={disabledTitle}
              aria-label={`Route source into ${selectedDirectRoute.channelId}`}
            >
              {selectedDirectRoute.selectValue.startsWith('source:')
                && !sourceOptions.some((option) => `source:${option.value}` === selectedDirectRoute.selectValue) && (
                <option value={selectedDirectRoute.selectValue}>Unavailable source</option>
              )}
              <option value="auto">Auto mix</option>
              <option value="mute">Mute speaker</option>
              {sourceOptions.map((option) => (
                <option key={option.value} value={`source:${option.value}`}>
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
          <p className="pipeline-note">{nativeRoutingDisabledMessage}</p>
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
            {binauralActive
              ? '2ch stereo (binaural)'
              : `${physicalSpeakerIds.length} speakers → ${hardwareRoutingPlan.hardwareBusWidth}ch hardware bus`}
          </span>
        </div>
        <div className="pipeline-chip-row">
          <span className="pipeline-chip pipeline-chip-device" title={selectedDeviceLabel}>
            {selectedDeviceLabel}
          </span>
          {hasOutputChannels && (
            <span className="pipeline-chip">Device capacity {formatChannels(deviceMaxChannels)}</span>
          )}
          <span className="pipeline-chip">Layout {getSpeakerLayoutDefinition(activeSpeakerProfile.layoutId).label}</span>
          {downmixActive && (
            <span className="pipeline-chip pipeline-chip-warning">
              Downmix {resolvedTrackChannels}{'->'}{effectiveOutputChannels}
            </span>
          )}
          {bitPerfectVerifiedActive && (
            <span className="pipeline-chip pipeline-chip-accent">Bit-perfect</span>
          )}
        </div>
        {binauralActive && (
          <p className="pipeline-note">
            Binaural rendering outputs stereo for headphones; the physical channel layout is not used.
          </p>
        )}

        <div className="pipeline-physical-config-head">
          <label className="pipeline-select-label">
            Physical speaker layout
            <select
              className="pipeline-select"
              value={activeSpeakerProfile.layoutId}
              onChange={(event) => void setSpeakerLayout(event.target.value as SpeakerLayoutPresetId)}
              disabled={bitPerfectModeActive || !hasOutputChannels}
              title={disabledTitle}
            >
              {SPEAKER_LAYOUT_PRESETS.map((preset) => (
                <option
                  key={preset.id}
                  value={preset.id}
                  disabled={hasOutputChannels && preset.speakers.length > resolvedDeviceMaxChannels}
                >
                  {preset.label} · {preset.speakers.length} speakers
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="pipeline-reset-btn"
            onClick={bitPerfectModeActive ? undefined : (() => void resetSpeakerProfile())}
            disabled={bitPerfectModeActive || !hasOutputChannels}
            title={disabledTitle ?? 'Reset this device to the safe Stereo configuration'}
          >
            Reset Configuration
          </button>
        </div>

        {hasOutputChannels ? (
          <div className="pipeline-physical-output-list" aria-label="Physical hardware output assignments">
            {outputLayout.map((speaker) => {
              const role = speaker.id as SpeakerRoleId
              const assignedOutput = activeSpeakerProfile.outputMap[role]
              return (
                <div className="pipeline-physical-output-row" key={role}>
                  <div className="pipeline-physical-output-speaker">
                    <strong>{role}</strong>
                    <span>{speaker.label}</span>
                  </div>
                  <select
                    className="pipeline-select"
                    value={assignedOutput ?? -1}
                    onChange={(event) => {
                      const value = Number(event.target.value)
                      void setSpeakerHardwareOutput(role, value >= 0 ? value : null)
                    }}
                    disabled={bitPerfectModeActive}
                    title={disabledTitle}
                    aria-label={`${speaker.label} hardware output`}
                  >
                    <option value={-1}>Unassigned</option>
                    {Array.from({ length: resolvedDeviceMaxChannels }, (_, outputIndex) => {
                      const occupiedByOtherSpeaker = physicalSpeakerIds.some((otherRole) => (
                        otherRole !== role && activeSpeakerProfile.outputMap[otherRole] === outputIndex
                      ))
                      return (
                        <option key={outputIndex} value={outputIndex} disabled={occupiedByOtherSpeaker}>
                          Output {outputIndex + 1}{occupiedByOtherSpeaker ? ' · In use' : ''}
                        </option>
                      )
                    })}
                  </select>
                  <button
                    type="button"
                    className={`pipeline-test-btn ${testingSpeakerRole === role ? 'active' : ''}`}
                    onClick={bitPerfectModeActive || assignedOutput == null
                      ? undefined
                      : (() => void playSpeakerTestTone(role))}
                    disabled={bitPerfectModeActive || assignedOutput == null}
                    title={disabledTitle ?? (assignedOutput == null
                      ? 'Assign a hardware output before testing this speaker'
                      : `Play a short test signal through Output ${assignedOutput + 1}`)}
                    aria-label={`Test ${speaker.label}`}
                  >
                    {testingSpeakerRole === role ? 'Testing…' : 'Test'}
                  </button>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="pipeline-note">Select an output device to detect its hardware output capacity.</p>
        )}

        {physicalSpeakerIds.some((role) => activeSpeakerProfile.outputMap[role] == null) && (
          <p className="pipeline-note pipeline-note-warning">
            Unassigned speakers remain silent until each one has a unique hardware output.
          </p>
        )}
        <p className="pipeline-note">
          Hardware outputs are device-specific. Source routing above may duplicate a source across speakers; hardware assignments remain one-to-one.
        </p>
      </div>
    </div>
  )
}
