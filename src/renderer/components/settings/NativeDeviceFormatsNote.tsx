import { useEffect, useState } from 'react'
import { useAudioSettingsStore } from '../../stores/audioSettingsStore'
import { usePlayerStore } from '../../stores/playerStore'
import type { NativeAudioDeviceFormatProbe, NativeAudioProbedSampleFormat } from '../../../types/nativeAudio'

const FORMAT_LABELS: Record<NativeAudioProbedSampleFormat, string> = {
  s16: '16-bit',
  s24: '24-bit',
  s24in32: '24-bit',
  s32: '32-bit',
  f32: '32-bit float'
}

function formatRate(sampleRate: number): string {
  const khz = sampleRate / 1000
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`
}

function summarizeProbe(probe: NativeAudioDeviceFormatProbe): string | null {
  if (!probe.supported || probe.formats.length === 0) return null

  const byRate = new Map<number, Set<string>>()
  for (const entry of probe.formats) {
    const label = FORMAT_LABELS[entry.sampleFormat] ?? entry.sampleFormat
    const existing = byRate.get(entry.sampleRate)
    if (existing) existing.add(label)
    else byRate.set(entry.sampleRate, new Set([label]))
  }

  return [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, labels]) => `${formatRate(rate)} (${[...labels].join(', ')})`)
    .join(' · ')
}

/**
 * Shows what the selected device actually accepts in exclusive mode. Astra previously gave
 * no visibility into this at all, so a device that only advertises one sample rate looked
 * like an Astra bug rather than a device setting.
 */
export default function NativeDeviceFormatsNote() {
  const playbackOutputMode = useAudioSettingsStore((state) => state.playbackOutputMode)
  const selectedDeviceId = useAudioSettingsStore((state) => state.selectedDeviceId)
  const formatNotice = usePlayerStore((state) => state.bitPerfectFormatNotice)
  const [summary, setSummary] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)

  useEffect(() => {
    if (playbackOutputMode !== 'bitperfect' || !window.nativeAudioAPI?.probeDeviceFormats) {
      setSummary(null)
      setReason(null)
      return
    }

    let cancelled = false
    void window.nativeAudioAPI
      .probeDeviceFormats(selectedDeviceId || undefined, 2)
      .then((probe) => {
        if (cancelled) return
        setSummary(summarizeProbe(probe))
        setReason(probe.supported ? null : probe.reason)
      })
      .catch(() => {
        if (!cancelled) {
          setSummary(null)
          setReason(null)
        }
      })

    return () => {
      cancelled = true
    }
    // Re-probe whenever a rejection is recorded: the device's own control panel may have
    // changed its rate since the last probe.
  }, [playbackOutputMode, selectedDeviceId, formatNotice?.id])

  if (playbackOutputMode !== 'bitperfect') return null
  if (!summary && !reason) return null

  return (
    <>
      {summary && (
        <p className="settings-note">
          Device accepts in exclusive mode (stereo): {summary}. Tracks in any other format won&apos;t play
          bit-perfect — most interfaces set their sample rate in their own control panel, not in Windows.
        </p>
      )}
      {reason && <p className="settings-note">{reason}</p>}
    </>
  )
}
