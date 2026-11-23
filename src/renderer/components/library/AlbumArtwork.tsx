import { memo, useEffect, useRef, useState } from 'react'
import { SUBSONIC_ARTWORK_HASH_PREFIX } from '../../../shared/library/artworkReference'
import { buildArtworkProtocolUrl, useLibraryStore } from '../../stores/libraryStore'
import type { ArtworkVariant } from '../../stores/libraryStore'
import { forgetDisplayedArtwork, hasDisplayedArtwork, rememberDisplayedArtwork } from '../../utils/displayedArtwork'
import { preloadArtwork } from '../../utils/preloadArtwork'
import {
  ARTWORK_PRELOAD_MARGIN_PX,
  isElementWithinPreloadRange,
  resolveArtworkScrollRoot
} from '../../utils/lazyArtworkVisibility'
import ArtworkImage from './ArtworkImage'

interface AlbumArtworkProps {
  hash: string | null
  alt?: string
  className?: string
  variant?: ArtworkVariant
  virtualized?: boolean
}

interface LazyAlbumArtworkProps {
  hash: string | null
  alt: string
  className: string
  variant: ArtworkVariant
}

function AlbumArtwork({
  hash,
  alt = 'Album artwork',
  className = '',
  variant = 'card',
  virtualized = false
}: AlbumArtworkProps) {
  if (virtualized || hash?.startsWith(SUBSONIC_ARTWORK_HASH_PREFIX)) {
    return (
      <ArtworkImage hash={hash} alt={alt} className={className} variant={variant}
        placeholderClassName={`album-artwork-placeholder ${className}`}>
        ♫
      </ArtworkImage>
    )
  }

  return <LazyAlbumArtwork hash={hash} alt={alt} className={className} variant={variant} />
}

function LazyAlbumArtwork({
  hash,
  alt,
  className,
  variant
}: LazyAlbumArtworkProps) {
  const requestedUrl = hash ? buildArtworkProtocolUrl(hash, variant) : null
  const [readyUrl, setArtworkUrl] = useState<string | null>(() => hasDisplayedArtwork(requestedUrl) ? requestedUrl : null)
  // A recycled card must never show its previous track's art for one render.
  const artworkUrl = readyUrl === requestedUrl ? readyUrl : hasDisplayedArtwork(requestedUrl) ? requestedUrl : null
  const [isVisible, setIsVisible] = useState(false)
  const placeholderRef = useRef<HTMLDivElement | null>(null)
  const getArtwork = useLibraryStore((state) => state.getArtwork)

  useEffect(() => {
    setArtworkUrl(hasDisplayedArtwork(requestedUrl) ? requestedUrl : null)
    setIsVisible(false)
  }, [requestedUrl])

  useEffect(() => {
    if (!hash) {
      setArtworkUrl(null)
      setIsVisible(false)
      return
    }

    if (artworkUrl) return
    if (isVisible) return

    const element = placeholderRef.current
    if (!element || typeof window === 'undefined') {
      setIsVisible(true)
      return
    }

    let isCancelled = false
    let observer: IntersectionObserver | null = null
    let rafId: number | null = null
    const settleTimeoutIds: number[] = []
    let resizeObserver: ResizeObserver | null = null
    const root = resolveArtworkScrollRoot(element)

    const cleanupVisibilityWatchers = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId)
        rafId = null
      }
      for (const timeoutId of settleTimeoutIds) {
        window.clearTimeout(timeoutId)
      }
      settleTimeoutIds.length = 0
      observer?.disconnect()
      observer = null
      resizeObserver?.disconnect()
      resizeObserver = null
    }

    const markVisible = () => {
      if (isCancelled) return
      cleanupVisibilityWatchers()
      setIsVisible(true)
    }

    const isWithinPreloadRange = () => isElementWithinPreloadRange(element, root, ARTWORK_PRELOAD_MARGIN_PX)
    const checkVisibility = () => {
      if (!isWithinPreloadRange()) return false
      markVisible()
      return true
    }

    if (checkVisibility()) {
      return () => {
        isCancelled = true
      }
    }

    if (typeof IntersectionObserver === 'undefined') {
      markVisible()
      return () => {
        isCancelled = true
      }
    }

    rafId = window.requestAnimationFrame(() => {
      if (isCancelled) return

      if (checkVisibility()) return

      observer = new IntersectionObserver((entries) => {
        const [entry] = entries
        if (!entry) return
        if (!entry.isIntersecting && !checkVisibility()) return

        markVisible()
      }, {
        root,
        rootMargin: `${ARTWORK_PRELOAD_MARGIN_PX}px`
      })

      observer.observe(element)

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
          checkVisibility()
        })
        resizeObserver.observe(element)
        if (root) {
          resizeObserver.observe(root)
        }
      }

      // Home sections stagger into place over ~550ms, so keep rechecking
      // briefly after mount until the layout and transforms have settled.
      for (const delayMs of [150, 350, 650]) {
        const timeoutId = window.setTimeout(() => {
          checkVisibility()
        }, delayMs)
        settleTimeoutIds.push(timeoutId)
      }
    })

    return () => {
      isCancelled = true
      cleanupVisibilityWatchers()
    }
  }, [artworkUrl, hash, isVisible])

  useEffect(() => {
    let isCancelled = false

    if (!hash || !isVisible || hasDisplayedArtwork(requestedUrl)) {
      return
    }

    void getArtwork(hash, { variant })
      .then(async (url) => {
        if (!url) return null
        return preloadArtwork(url)
      })
      .then((url) => {
        if (isCancelled) return
        if (url) rememberDisplayedArtwork(url)
        setArtworkUrl(url)
      })
      .catch(() => {
        if (isCancelled) return
        setArtworkUrl(null)
      })

    return () => {
      isCancelled = true
    }
  }, [getArtwork, hash, isVisible, variant, requestedUrl])

  if (!hash || !artworkUrl) {
    return (
      <div ref={placeholderRef} className={`album-artwork-placeholder ${className}`}>
        ♫
      </div>
    )
  }

  return (
    <img
      src={artworkUrl!}
      alt={alt}
      className={className}
      // Warm URLs may be reused before the visibility observer runs. Keep
      // those images lazy: a display hint must not load every offscreen card.
      loading={isVisible ? 'eager' : 'lazy'}
      decoding="async"
      onLoad={() => rememberDisplayedArtwork(artworkUrl)}
      onError={() => {
        forgetDisplayedArtwork(artworkUrl)
        setArtworkUrl(null)
        setIsVisible(false)
      }}
    />
  )
}

export default memo(AlbumArtwork)
