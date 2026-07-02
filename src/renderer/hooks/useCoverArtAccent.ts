import { useEffect, useRef } from 'react'
import { useLibraryStore } from '../stores/libraryStore'
import { usePlayerStore } from '../stores/playerStore'
import { useThemeStore } from '../stores/themeStore'
import { extractArtworkAccent } from '../utils/artworkAccent'

const MAX_COVER_ART_ACCENT_CACHE_ENTRIES = 256

const coverArtAccentCache = new Map<string, string | null>()

function getCoverArtAccentCacheEntry(cacheKey: string): string | null | undefined {
  if (!coverArtAccentCache.has(cacheKey)) return undefined
  const value = coverArtAccentCache.get(cacheKey) ?? null
  coverArtAccentCache.delete(cacheKey)
  coverArtAccentCache.set(cacheKey, value)
  return value
}

function setCoverArtAccentCacheEntry(cacheKey: string, value: string | null): void {
  coverArtAccentCache.delete(cacheKey)
  coverArtAccentCache.set(cacheKey, value)
  while (coverArtAccentCache.size > MAX_COVER_ART_ACCENT_CACHE_ENTRIES) {
    const oldestKey = coverArtAccentCache.keys().next().value
    if (oldestKey === undefined) break
    coverArtAccentCache.delete(oldestKey)
  }
}

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
        artworkDataUrl = await getArtwork(currentTrack.artworkHash, { variant: 'card' })
        if (requestTokenRef.current !== requestToken) return
      }

      if (!artworkDataUrl) {
        setCoverArtAccent(null)
        return
      }

      const artworkIdentity = buildArtworkIdentity(currentTrack)
      const cacheKey = `${coverArtAccentMethod}:${artworkIdentity}`

      const cachedAccent = getCoverArtAccentCacheEntry(cacheKey)
      if (cachedAccent !== undefined) {
        setCoverArtAccent(cachedAccent)
        return
      }

      const accent = await extractArtworkAccent(artworkDataUrl, coverArtAccentMethod)
      if (requestTokenRef.current !== requestToken) return

      setCoverArtAccentCacheEntry(cacheKey, accent)
      setCoverArtAccent(accent)
    }

    void resolveCoverArtAccent()

    return () => {
      requestTokenRef.current += 1
    }
  }, [accentSource, coverArtAccentMethod, currentTrack, getArtwork, setCoverArtAccent])
}
