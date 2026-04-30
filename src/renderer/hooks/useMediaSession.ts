import { useEffect } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { useLibraryStore } from '../stores/libraryStore'

/** Convert a data URL to a blob URL (avoids MediaSession's URL length limit). */
function dataUrlToBlobUrl(dataUrl: string): string {
  const [header, base64] = dataUrl.split(',')
  const mime = header.match(/:(.*?);/)?.[1] ?? 'image/jpeg'
  const bytes = atob(base64)
  const arr = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
  return URL.createObjectURL(new Blob([arr], { type: mime }))
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}

/**
 * Chromium only keeps MediaSession active while an <audio> element is playing.
 * Web Audio API alone doesn't do it. We create a persistent silent looping
 * <audio> element and sync its play/pause with the real playback state.
 */
function createSilentAudio(): HTMLAudioElement {
  const sampleRate = 8000
  const numSamples = sampleRate // 1 second of silence
  const dataSize = numSamples * 2 // 16-bit mono
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)
  // data bytes are already zeros = silence

  const audio = document.createElement('audio')
  audio.src = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
  audio.loop = true
  audio.volume = 0
  return audio
}

export function useMediaSession(): void {
  useEffect(() => {
    if (!('mediaSession' in navigator)) return

    const session = navigator.mediaSession
    const silentAudio = createSilentAudio()
    let currentBlobUrl: string | null = null

    // --- Action handlers (media keys) ---

    session.setActionHandler('play', () => {
      usePlayerStore.getState().play()
    })

    session.setActionHandler('pause', () => {
      usePlayerStore.getState().pause()
    })

    session.setActionHandler('previoustrack', () => {
      usePlayerStore.getState().playPrevious()
    })

    session.setActionHandler('nexttrack', () => {
      usePlayerStore.getState().playNext()
    })

    session.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) {
        usePlayerStore.getState().seek(details.seekTime)
      }
    })

    session.setActionHandler('seekbackward', (details) => {
      const skipTime = details.seekOffset ?? 10
      const { currentTime } = usePlayerStore.getState()
      usePlayerStore.getState().seek(Math.max(0, currentTime - skipTime))
    })

    session.setActionHandler('seekforward', (details) => {
      const skipTime = details.seekOffset ?? 10
      const { currentTime, duration } = usePlayerStore.getState()
      usePlayerStore.getState().seek(Math.min(duration, currentTime + skipTime))
    })

    // --- Metadata & playback state sync ---

    let prevTrackId: string | null = null
    let prevPlaybackState: string | null = null

    async function updateMetadata(): Promise<void> {
      const { currentTrack } = usePlayerStore.getState()
      if (!currentTrack) {
        session.metadata = null
        return
      }

      if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl)
        currentBlobUrl = null
      }

      let artworkDataUrl: string | undefined
      if (currentTrack.artworkData) {
        artworkDataUrl = currentTrack.artworkData
      } else if (currentTrack.artworkHash) {
        artworkDataUrl =
          (await useLibraryStore.getState().getArtwork(currentTrack.artworkHash, {
            variant: 'card',
            format: 'data-url'
          })) ?? undefined
      }

      const artwork: MediaImage[] = []
      if (artworkDataUrl) {
        try {
          const blobUrl = dataUrlToBlobUrl(artworkDataUrl)
          currentBlobUrl = blobUrl
          const mime = artworkDataUrl.match(/^data:([^;,]+)/)?.[1] ?? 'image/jpeg'
          artwork.push({ src: blobUrl, sizes: '512x512', type: mime })
        } catch {
          // skip artwork if conversion fails
        }
      }

      session.metadata = new MediaMetadata({
        title: currentTrack.title,
        artist: currentTrack.artist,
        album: currentTrack.album,
        artwork
      })
    }

    function syncPlaybackState(): void {
      const { playbackState, currentTime, duration } = usePlayerStore.getState()

      // Keep silent audio element in sync — this is what keeps MediaSession alive
      if (playbackState === 'playing') {
        silentAudio.play().catch(() => {})
        session.playbackState = 'playing'
      } else {
        silentAudio.pause()
        session.playbackState = playbackState === 'paused' ? 'paused' : 'none'
      }

      if (duration > 0) {
        try {
          session.setPositionState({
            duration,
            position: Math.min(currentTime, duration),
            playbackRate: 1.0
          })
        } catch {
          // ignore invalid position states
        }
      }
    }

    const unsubscribe = usePlayerStore.subscribe((state) => {
      const trackId = state.currentTrack?.id ?? null
      const playbackState = state.playbackState

      if (trackId !== prevTrackId) {
        prevTrackId = trackId
        updateMetadata()
        syncPlaybackState()
      } else if (playbackState !== prevPlaybackState) {
        prevPlaybackState = playbackState
        syncPlaybackState()
      }
    })

    // --- Cleanup ---

    return () => {
      unsubscribe()
      silentAudio.pause()
      URL.revokeObjectURL(silentAudio.src)
      silentAudio.remove()
      if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl)
      }
      const actions: MediaSessionAction[] = [
        'play',
        'pause',
        'previoustrack',
        'nexttrack',
        'seekto',
        'seekbackward',
        'seekforward'
      ]
      for (const action of actions) {
        try {
          session.setActionHandler(action, null)
        } catch {
          // ignore
        }
      }
      session.metadata = null
      session.playbackState = 'none'
    }
  }, [])
}
