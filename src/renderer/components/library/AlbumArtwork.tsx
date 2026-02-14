import { useState, useEffect } from 'react'
import { useLibraryStore } from '../../stores/libraryStore'

interface AlbumArtworkProps {
  hash: string | null
  alt?: string
  className?: string
}

export default function AlbumArtwork({ hash, alt = 'Album artwork', className = '' }: AlbumArtworkProps) {
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const getArtwork = useLibraryStore((state) => state.getArtwork)

  useEffect(() => {
    let isCancelled = false

    if (!hash) {
      setArtworkUrl(null)
      setLoading(false)
      return
    }

    setLoading(true)
    setArtworkUrl(null)

    void getArtwork(hash)
      .then((url) => {
        if (isCancelled) return
        setArtworkUrl(url)
        setLoading(false)
      })
      .catch(() => {
        if (isCancelled) return
        setArtworkUrl(null)
        setLoading(false)
      })

    return () => {
      isCancelled = true
    }
  }, [hash, getArtwork])

  if (!hash || (!loading && !artworkUrl)) {
    return (
      <div className={`album-artwork-placeholder ${className}`}>
        ♫
      </div>
    )
  }

  if (loading) {
    return (
      <div className={`album-artwork-placeholder ${className}`}>
        <div className="loading-spinner-small" />
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
        setLoading(false)
      }}
    />
  )
}
