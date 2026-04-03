import { useEffect, useRef } from 'react'
import { useLibraryStore } from '../stores/libraryStore'
import { usePlayerStore } from '../stores/playerStore'
import { useThemeStore } from '../stores/themeStore'
import { extractArtworkAccent } from '../utils/artworkAccent'

const coverArtAccentCache = new Map<string, string | null>()

function estimateAccentCacheBytes(): number {
  let total = 0
  for (const [cacheKey, value] of coverArtAccentCache.entries()) {
    total += (cacheKey.length * 2) + ((value ?? '').length * 2)
  }
  return total
}

function buildArtworkIdentity(track: { id: string; path: string; artworkHash?: string }): string {
  if (track.artworkHash) {
    return `hash:${track.artworkHash}`
  }

  if (track.path) {
    return `path:${track.path}`
  }

  return `id:${track.id}`
}

export function getCoverArtAccentDiagnosticsSnapshot(): {
  coverArtAccentEntries: number
  coverArtAccentBytes: number
} {
  return {
    coverArtAccentEntries: coverArtAccentCache.size,
    coverArtAccentBytes: estimateAccentCacheBytes()
  }
}

export function useCoverArtAccent(): void {
  const currentTrack = usePlayerStore((state) => state.currentTrack)
  const getArtwork = useLibraryStore((state) => state.getArtwork)

  const accentSource = useThemeStore((state) => state.accentSource)
  const coverArtAccentMethod = useThemeStore((state) => state.coverArtAccentMethod)
  const setCoverArtAccent = useThemeStore((state) => state.setCoverArtAccent)

  const requestTokenRef = useRef(0)

  useEffect(() => {
    requestTokenRef.current += 1
    const requestToken = requestTokenRef.current

    if (accentSource !== 'cover-art') {
      setCoverArtAccent(null)
      return () => {
        requestTokenRef.current += 1
      }
    }

    if (!currentTrack) {
      setCoverArtAccent(null)
      return () => {
        requestTokenRef.current += 1
      }
    }

    const resolveCoverArtAccent = async () => {
      let artworkDataUrl = currentTrack.artworkData ?? null

      if (!artworkDataUrl && currentTrack.artworkHash) {
        artworkDataUrl = await getArtwork(currentTrack.artworkHash)
        if (requestTokenRef.current !== requestToken) return
      }

      if (!artworkDataUrl) {
        setCoverArtAccent(null)
        return
      }

      const artworkIdentity = buildArtworkIdentity(currentTrack)
      const cacheKey = `${coverArtAccentMethod}:${artworkIdentity}`

      if (coverArtAccentCache.has(cacheKey)) {
        setCoverArtAccent(coverArtAccentCache.get(cacheKey) ?? null)
        return
      }

      const accent = await extractArtworkAccent(artworkDataUrl, coverArtAccentMethod)
      if (requestTokenRef.current !== requestToken) return

      coverArtAccentCache.set(cacheKey, accent)
      setCoverArtAccent(accent)
    }

    void resolveCoverArtAccent()

    return () => {
      requestTokenRef.current += 1
    }
  }, [accentSource, coverArtAccentMethod, currentTrack, getArtwork, setCoverArtAccent])
}
