import { useEffect } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { useDiscordSettingsStore } from '../stores/discordSettingsStore'

type PlayerSnapshot = ReturnType<typeof usePlayerStore.getState>

const PLAYING_PROGRESS_BUCKET_SECONDS = 15
const IDLE_PROGRESS_BUCKET_SECONDS = 1

function normalizeSeconds(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined
  if (value < 0) return 0
  return Math.floor(value)
}

function getProgressBucket(playbackState: PlayerSnapshot['playbackState'], currentTime: number): number {
  const seconds = normalizeSeconds(currentTime) ?? 0
  const bucketSize = playbackState === 'playing'
    ? PLAYING_PROGRESS_BUCKET_SECONDS
    : IDLE_PROGRESS_BUCKET_SECONDS
  return Math.floor(seconds / bucketSize)
}

function shouldEmitUpdate(nextState: PlayerSnapshot, prevState: PlayerSnapshot): boolean {
  if (nextState.currentTrack?.path !== prevState.currentTrack?.path) return true
  if (nextState.playbackState !== prevState.playbackState) return true
  if (Math.floor(nextState.duration) !== Math.floor(prevState.duration)) return true
  return getProgressBucket(nextState.playbackState, nextState.currentTime) !==
    getProgressBucket(prevState.playbackState, prevState.currentTime)
}

function buildPresenceUpdate(state: PlayerSnapshot): {
  key: string
  payload: {
    playbackState: 'stopped' | 'playing' | 'paused' | 'loading'
    currentTimeSeconds?: number
    durationSeconds?: number
    track?: {
      title: string
      artist?: string
      album?: string
      durationSeconds?: number
      format?: string
      sampleRate?: number
      bitDepth?: number
      bitrate?: number
      channels?: number
      codec?: string
      codecProfile?: string
      isAtmosJoc?: boolean
      artworkData?: string
      artworkHash?: string
    } | null
  }
} {
  const { currentTrack, playbackState } = state
  if (!currentTrack || playbackState === 'stopped') {
    return {
      key: 'stopped',
      payload: {
        playbackState: 'stopped',
        track: null
      }
    }
  }

  const currentTimeSeconds = normalizeSeconds(state.currentTime)
  const durationSeconds = normalizeSeconds(state.duration || currentTrack.duration)
  const progressBucket = getProgressBucket(playbackState, state.currentTime)

  return {
    key: JSON.stringify({
      trackPath: currentTrack.path,
      playbackState,
      progressBucket,
      durationSeconds,
      format: currentTrack.format,
      sampleRate: currentTrack.sampleRate,
      bitDepth: currentTrack.bitDepth,
      bitrate: currentTrack.bitrate,
      channels: currentTrack.channels,
      codec: currentTrack.codec,
      codecProfile: currentTrack.codecProfile,
      isAtmosJoc: currentTrack.isAtmosJoc
    }),
    payload: {
      playbackState,
      currentTimeSeconds,
      durationSeconds,
      track: {
        title: currentTrack.title,
        artist: currentTrack.artist,
        album: currentTrack.album,
        durationSeconds: normalizeSeconds(currentTrack.duration),
        format: currentTrack.format,
        sampleRate: currentTrack.sampleRate,
        bitDepth: currentTrack.bitDepth,
        bitrate: currentTrack.bitrate,
        channels: currentTrack.channels,
        codec: currentTrack.codec,
        codecProfile: currentTrack.codecProfile,
        isAtmosJoc: currentTrack.isAtmosJoc,
        artworkData: currentTrack.artworkData,
        artworkHash: currentTrack.artworkHash
      }
    }
  }
}

export function useDiscordPresence(): void {
  const enabled = useDiscordSettingsStore((s) => s.enabled)

  useEffect(() => {
    if (!enabled) {
      window.electronAPI.discord.clearPresence()
      return
    }

    let lastKey = ''

    const emitLatest = () => {
      const snapshot = buildPresenceUpdate(usePlayerStore.getState())
      if (snapshot.key === lastKey) return
      lastKey = snapshot.key
      window.electronAPI.discord.updatePresence(snapshot.payload)
    }

    emitLatest()

    const unsubscribe = usePlayerStore.subscribe((nextState, prevState) => {
      if (!shouldEmitUpdate(nextState, prevState)) return
      emitLatest()
    })

    return () => {
      unsubscribe()
    }
  }, [enabled])
}
