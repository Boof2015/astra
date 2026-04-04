import { useEffect, useRef, useState } from 'react'
import { useLibraryStore } from '../../stores/libraryStore'
import type { ArtworkVariant } from '../../stores/libraryStore'
import {
  ARTWORK_PRELOAD_MARGIN_PX,
  isElementWithinPreloadRange,
  resolveArtworkScrollRoot
} from '../../utils/lazyArtworkVisibility'

interface AlbumArtworkProps {
  hash: string | null
  alt?: string
  className?: string
  variant?: ArtworkVariant
}

function preloadArtwork(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    let settled = false

    const finish = (next: () => void) => {
      if (settled) return
      settled = true
      next()
    }

    image.decoding = 'async'
    image.onload = () => finish(() => resolve(url))
    image.onerror = () => finish(() => reject(new Error('Failed to decode artwork image')))
    image.src = url

    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      finish(() => resolve(url))
      return
    }

    if (typeof image.decode === 'function') {
      void image.decode()
        .then(() => {
          finish(() => resolve(url))
        })
        .catch(() => {
          // Keep onload/onerror as the fallback path for browsers that reject decode().
        })
    }
  })
}

export default function AlbumArtwork({
  hash,
  alt = 'Album artwork',
  className = '',
  variant = 'card'
}: AlbumArtworkProps) {
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null)
  const [isVisible, setIsVisible] = useState(false)
  const placeholderRef = useRef<HTMLDivElement | null>(null)
  const getArtwork = useLibraryStore((state) => state.getArtwork)

  useEffect(() => {
    setArtworkUrl(null)
    setIsVisible(false)
  }, [hash, variant])

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

    if (!hash || !isVisible) {
      return
    }

    void getArtwork(hash, { variant })
      .then(async (url) => {
        if (!url) return null
        return preloadArtwork(url)
      })
      .then((url) => {
        if (isCancelled) return
        setArtworkUrl(url)
      })
      .catch(() => {
        if (isCancelled) return
        setArtworkUrl(null)
      })

    return () => {
      isCancelled = true
    }
  }, [getArtwork, hash, isVisible, variant])

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
      loading="eager"
      decoding="async"
      onError={() => {
        setArtworkUrl(null)
        setIsVisible(false)
      }}
    />
  )
}
