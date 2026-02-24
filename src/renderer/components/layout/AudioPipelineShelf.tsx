import React, { useMemo } from 'react'
import { usePlayerStore } from '../../stores/playerStore'
import { useEQStore } from '../../stores/eqStore'
import { useAudioSettingsStore } from '../../stores/audioSettingsStore'
import { useUIStore } from '../../stores/uiStore'
import { audioEngine } from '../../audio/AudioEngine'

interface PipelineNode {
  id: string
  icon: React.ReactNode
  label: string
  detail: string
}

function PipelineArrow() {
  return (
    <div className="pipeline-arrow">
      <svg width="16" height="10" viewBox="0 0 16 10" fill="none">
        <path
          d="M0 5h13m0 0l-3.5-3.5M13 5l-3.5 3.5"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}

function PipelineNodeCard({ node }: { node: PipelineNode }) {
  return (
    <div className="pipeline-node">
      <div className="pipeline-node-icon">{node.icon}</div>
      <div className="pipeline-node-text">
        <span className="pipeline-node-label">{node.label}</span>
        <span className="pipeline-node-detail">{node.detail}</span>
      </div>
    </div>
  )
}

// Icons as inline SVGs
const SourceIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </svg>
)

const DecoderIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M9 9h6v6H9z" />
  </svg>
)

const ResamplerIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12h4l3-9 4 18 3-9h4" />
  </svg>
)

const RoutingIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 3h5v5" />
    <path d="M4 20L21 3" />
    <path d="M21 16v5h-5" />
    <path d="M15 15l6 6" />
    <path d="M4 4l5 5" />
  </svg>
)

const NormIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 20h20" />
    <path d="M5 20V10" />
    <path d="M9 20V4" />
    <path d="M13 20V14" />
    <path d="M17 20V8" />
    <path d="M21 20V12" />
  </svg>
)

const EQIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 21V14" />
    <path d="M4 10V3" />
    <path d="M12 21V12" />
    <path d="M12 8V3" />
    <path d="M20 21V16" />
    <path d="M20 12V3" />
    <line x1="1" y1="14" x2="7" y2="14" />
    <line x1="9" y1="8" x2="15" y2="8" />
    <line x1="17" y1="16" x2="23" y2="16" />
  </svg>
)

const DelayIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </svg>
)

const OutputIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 5L6 9H2v6h4l5 4V5z" />
    <path d="M15.54 8.46a5 5 0 010 7.07" />
    <path d="M19.07 4.93a10 10 0 010 14.14" />
  </svg>
)

export default function AudioPipelineShelf() {
  const showShelf = useUIStore((s) => s.showPipelineShelf)
  const currentTrack = usePlayerStore((s) => s.currentTrack)
  const eqEnabled = useEQStore((s) => s.enabled)
  const eqBands = useEQStore((s) => s.bands)
  const selectedDeviceId = useAudioSettingsStore((s) => s.selectedDeviceId)
  const availableDevices = useAudioSettingsStore((s) => s.availableDevices)
  const effectiveDelayMs = useAudioSettingsStore((s) => s.effectiveDelayMs)
  const multichannelEnabled = useAudioSettingsStore((s) => s.multichannelEnabled)
  const channelRoutingMap = useAudioSettingsStore((s) => s.channelRoutingMap)

  const nodes = useMemo((): PipelineNode[] => {
    if (!currentTrack) return []

    const result: PipelineNode[] = []

    // Source
    const fmt = currentTrack.format?.toUpperCase() ?? '?'
    const isLossy = ['MP3', 'AAC', 'OGG', 'OPUS', 'WMA'].includes(fmt)
    let sourceDetail: string
    if (isLossy) {
      const kbps = currentTrack.bitrate ? `${currentTrack.bitrate}k` : ''
      sourceDetail = kbps ? `${fmt} ${kbps}` : fmt
    } else {
      const bd = currentTrack.bitDepth ?? ''
      const sr = currentTrack.sampleRate ? (currentTrack.sampleRate / 1000).toFixed(1) : ''
      sourceDetail = bd && sr ? `${fmt} ${bd}/${sr}` : fmt
    }
    result.push({ id: 'source', icon: SourceIcon, label: 'Source', detail: sourceDetail })

    // Decoder
    result.push({ id: 'decoder', icon: DecoderIcon, label: 'Decoder', detail: 'Web Audio API' })

    // Resampler (only if sample rates differ)
    const trackSR = currentTrack.sampleRate
    const contextSR = audioEngine.getSampleRate()
    if (trackSR && contextSR && trackSR !== contextSR) {
      const from = (trackSR / 1000).toFixed(1)
      const to = (contextSR / 1000).toFixed(1)
      result.push({ id: 'resampler', icon: ResamplerIcon, label: 'Resampler', detail: `${from} \u2192 ${to} kHz` })
    }

    // Channel Routing
    if (multichannelEnabled && channelRoutingMap && channelRoutingMap.length > 0) {
      const srcCh = currentTrack.channels ?? 2
      const outCh = channelRoutingMap.length
      result.push({ id: 'routing', icon: RoutingIcon, label: 'Routing', detail: `${srcCh}ch \u2192 ${outCh}ch` })
    }

    // Normalization
    if (audioEngine.normalizationEnabled) {
      const gainMode = audioEngine.getNormalizationMode()
      const gainDb = audioEngine.getNormalizationGainDb()
      const rounded = Math.round(gainDb * 10) / 10
      const displayDb = Math.abs(rounded) < 0.05 ? 0 : rounded
      const sign = displayDb > 0 ? '+' : ''
      result.push({
        id: 'norm',
        icon: NormIcon,
        label: gainMode === 'replaygain' ? 'ReplayGain' : 'Normalization',
        detail: `${sign}${displayDb.toFixed(1)} dB`
      })
    }

    // EQ
    if (eqEnabled) {
      result.push({ id: 'eq', icon: EQIcon, label: 'EQ', detail: `${eqBands.length} bands` })
    }

    // Delay Compensation
    if (effectiveDelayMs > 0) {
      result.push({ id: 'delay', icon: DelayIcon, label: 'Delay Comp.', detail: `${effectiveDelayMs} ms` })
    }

    // Output Device
    const device = availableDevices.find((d) => d.deviceId === selectedDeviceId)
    const deviceLabel = device ? device.label.replace(/\s*\(.*?\)\s*$/, '') : 'System Default'
    const outSR = (contextSR / 1000).toFixed(1)
    result.push({ id: 'output', icon: OutputIcon, label: 'Output', detail: `${deviceLabel} @ ${outSR} kHz` })

    return result
  }, [
    currentTrack,
    eqEnabled,
    eqBands.length,
    selectedDeviceId,
    availableDevices,
    effectiveDelayMs,
    multichannelEnabled,
    channelRoutingMap,
  ])

  return (
    <div className={`pipeline-shelf${showShelf ? ' pipeline-shelf-open' : ''}`}>
      <div className="pipeline-shelf-content">
        {nodes.length === 0 ? (
          <div className="pipeline-shelf-empty">No active signal chain</div>
        ) : (
          <div className="pipeline-shelf-chain">
            {nodes.map((node, i) => (
              <React.Fragment key={node.id}>
                {i > 0 && <PipelineArrow />}
                <PipelineNodeCard node={node} />
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
