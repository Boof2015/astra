import { useEffect, useRef, useState } from 'react'
import { useLibraryStore } from '../../stores/libraryStore'

interface AlbumArtworkProps {
  hash: string | null
  alt?: string
  className?: string
}

export default function AlbumArtwork({ hash, alt = 'Album artwork', className = '' }: AlbumArtworkProps) {
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null)
  const [isVisible, setIsVisible] = useState(false)
  const placeholderRef = useRef<HTMLDivElement | null>(null)
  const getArtwork = useLibraryStore((state) => state.getArtwork)

  useEffect(() => {
    setArtworkUrl(null)
    setIsVisible(false)
  }, [hash])

  useEffect(() => {
    if (!hash) {
      setArtworkUrl(null)
      setIsVisible(false)
      return
    }

    if (artworkUrl) return
    if (isVisible) return

    const element = placeholderRef.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setIsVisible(true)
      return
    }

    const observer = new IntersectionObserver((entries) => {
      const [entry] = entries
      if (!entry?.isIntersecting) return
      setIsVisible(true)
      observer.disconnect()
    }, {
      root: null,
      rootMargin: '240px 0px'
    })

    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [artworkUrl, hash, isVisible])

  useEffect(() => {
    let isCancelled = false

    if (!hash || !isVisible) {
      return
    }

    void getArtwork(hash)
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
  }, [hash, getArtwork, isVisible])

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
      loading="lazy"
      decoding="async"
      onError={() => {
        setArtworkUrl(null)
        setIsVisible(false)
      }}
    />
  )
}
