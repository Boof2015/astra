import { useEffect, useMemo, useRef, useState } from 'react'
import type { AstraActivityPulse } from '../components/activity/AstraActivityIndicator'
import { useDiscordSettingsStore } from '../stores/discordSettingsStore'
import { useJellyfinSettingsStore } from '../stores/jellyfinSettingsStore'
import { useLastFmSettingsStore } from '../stores/lastFmSettingsStore'
import { useLibraryIntegrityStore } from '../stores/libraryIntegrityStore'
import { useLibraryStore } from '../stores/libraryStore'
import { useLocalApiSettingsStore } from '../stores/localApiSettingsStore'
import { useLyricsStore } from '../stores/lyricsStore'
import { useMetadataEditorStore } from '../stores/metadataEditorStore'
import { usePhoneRemoteSettingsStore } from '../stores/phoneRemoteSettingsStore'
import { useParallaxStore } from '../stores/parallaxStore'
import { usePlayerStore } from '../stores/playerStore'
import { useSubsonicSettingsStore } from '../stores/subsonicSettingsStore'
import { useUpdateStore } from '../stores/updateStore'
import {
  ASTRA_ACTIVITY_STATE_NOTES,
  isParallaxConnectionActive,
  resolveAstraActivityEvent,
  resolveAstraActivityState,
  type AstraActivityEventFlags,
  type AstraActivityState,
} from '../utils/astraActivity'

export interface AstraActivitySnapshot {
  state: AstraActivityState
  event: AstraActivityPulse | null
  note: string
}

const EMPTY_EVENT_FLAGS: AstraActivityEventFlags = {
  metadataSaving: false,
  externalConnected: false,
  attention: false,
}

export function useAstraActivity(): AstraActivitySnapshot {
  const playbackState = usePlayerStore((state) => state.playbackState)
  const remoteLoadProgress = usePlayerStore((state) => state.remoteLoadProgress)
  const remoteStreamSessionId = usePlayerStore((state) => state.remoteStreamSessionId)
  const waveformBufferedRatio = usePlayerStore((state) => state.waveformBufferedRatio)
  const waveformAnalyzedRatio = usePlayerStore((state) => state.waveformAnalyzedRatio)

  const isLibraryScanning = useLibraryStore((state) => state.isScanning)
  const isIntegrityScanning = useLibraryIntegrityStore((state) => state.isScanning)
  const integrityError = useLibraryIntegrityStore((state) => Boolean(state.errorMessage || state.singleTrackError))
  const isLyricsLookup = useLyricsStore((state) => state.isLoading)
  const lyricsError = useLyricsStore((state) => Boolean(state.errorMessage || state.status?.lastError))
  const discordCoverArtLookupActive = useDiscordSettingsStore((state) => state.coverArtLookupActive)
  const metadataSaving = useMetadataEditorStore((state) => state.isSaving)
  const metadataFailed = useMetadataEditorStore((state) => (state.lastResult?.failed ?? 0) > 0)

  const subsonicSyncing = useSubsonicSettingsStore((state) => Boolean(state.status?.isSyncing))
  const subsonicError = useSubsonicSettingsStore((state) => (
    Boolean(state.errorMessage)
    || Boolean(state.status?.sources.some((source) => source.status === 'error' || Boolean(source.error)))
  ))
  const jellyfinSyncing = useJellyfinSettingsStore((state) => Boolean(state.status?.isSyncing))
  const jellyfinError = useJellyfinSettingsStore((state) => (
    Boolean(state.errorMessage)
    || Boolean(state.status?.sources.some((source) => source.status === 'error' || Boolean(source.error)))
  ))

  const localApiConnected = useLocalApiSettingsStore((state) => (state.status?.connectedClients ?? 0) > 0)
  const localApiError = useLocalApiSettingsStore((state) => Boolean(state.errorMessage || state.status?.lastError))
  const phoneRemoteConnected = usePhoneRemoteSettingsStore((state) => (state.status?.connectedClients ?? 0) > 0)
  const phoneRemoteError = usePhoneRemoteSettingsStore((state) => Boolean(state.errorMessage || state.status?.lastError))
  const isParallaxConnected = useParallaxStore((state) => isParallaxConnectionActive(state.status))
  const lastFmError = useLastFmSettingsStore((state) => Boolean(state.errorMessage || state.status?.lastError))
  const updateError = useUpdateStore((state) => state.checkState === 'error')

  const [eventPulse, setEventPulse] = useState<AstraActivityPulse | null>(null)
  const previousEventFlagsRef = useRef<AstraActivityEventFlags>(EMPTY_EVENT_FLAGS)
  const nextEventPulseIdRef = useRef(0)
  const clearEventPulseTimerRef = useRef<number | null>(null)

  const isRemoteStreaming = Boolean(
    remoteLoadProgress
    && !remoteLoadProgress.failed
    && !remoteLoadProgress.done
    && (
      remoteLoadProgress.stage === 'downloading'
      || remoteLoadProgress.stage === 'streaming'
      || remoteStreamSessionId !== null
      || waveformBufferedRatio < 0.999
      || waveformAnalyzedRatio < 0.999
    )
  )

  const state = resolveAstraActivityState({
    playbackState,
    isIntegrityScanning,
    isLibraryScanning,
    isRemoteSyncing: subsonicSyncing || jellyfinSyncing,
    isRemoteStreaming,
    isInternetLookup: isLyricsLookup || discordCoverArtLookupActive,
    isParallaxConnected,
  })

  const eventFlags = useMemo<AstraActivityEventFlags>(() => ({
    metadataSaving,
    externalConnected: localApiConnected || phoneRemoteConnected,
    attention: (
      integrityError
      || lyricsError
      || metadataFailed
      || subsonicError
      || jellyfinError
      || localApiError
      || phoneRemoteError
      || lastFmError
      || updateError
    ),
  }), [
    integrityError,
    jellyfinError,
    lastFmError,
    localApiConnected,
    localApiError,
    lyricsError,
    metadataFailed,
    metadataSaving,
    phoneRemoteConnected,
    phoneRemoteError,
    subsonicError,
    updateError,
  ])

  useEffect(() => {
    const previousEventFlags = previousEventFlagsRef.current
    const event = resolveAstraActivityEvent(eventFlags, previousEventFlags)
    previousEventFlagsRef.current = eventFlags

    if (!event) return

    nextEventPulseIdRef.current += 1
    const nextPulse = {
      id: nextEventPulseIdRef.current,
      kind: event,
    }
    setEventPulse(nextPulse)

    if (clearEventPulseTimerRef.current !== null) {
      window.clearTimeout(clearEventPulseTimerRef.current)
    }
    clearEventPulseTimerRef.current = window.setTimeout(() => {
      setEventPulse((currentPulse) => currentPulse?.id === nextPulse.id ? null : currentPulse)
      clearEventPulseTimerRef.current = null
    }, 1300)
  }, [eventFlags])

  useEffect(() => {
    return () => {
      if (clearEventPulseTimerRef.current !== null) {
        window.clearTimeout(clearEventPulseTimerRef.current)
      }
    }
  }, [])

  return {
    state,
    event: eventPulse,
    note: ASTRA_ACTIVITY_STATE_NOTES[state],
  }
}
