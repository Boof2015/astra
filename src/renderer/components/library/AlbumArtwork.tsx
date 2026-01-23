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
    if (!hash) {
      console.log('[AlbumArtwork] No hash provided')
      setArtworkUrl(null)
      return
    }

    console.log(`[AlbumArtwork] Loading artwork for hash: ${hash}`)
    setLoading(true)
    getArtwork(hash).then((url) => {
      console.log(`[AlbumArtwork] Got URL for ${hash}:`, url ? `${url.substring(0, 50)}...` : 'null')
      setArtworkUrl(url)
      setLoading(false)
    }).catch((err) => {
      console.error(`[AlbumArtwork] Error loading ${hash}:`, err)
      setLoading(false)
    })
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
      onError={(e) => {
        // If image fails to load, show placeholder
        e.currentTarget.style.display = 'none'
        e.currentTarget.parentElement?.classList.add('artwork-error')
      }}
    />
  )
}
