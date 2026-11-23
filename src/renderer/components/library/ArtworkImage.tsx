import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SUBSONIC_ARTWORK_HASH_PREFIX } from '../../../shared/library/artworkReference'
import { buildArtworkProtocolUrl, type ArtworkVariant } from '../../stores/libraryStore'
import { forgetDisplayedArtwork, hasDisplayedArtwork, rememberDisplayedArtwork } from '../../utils/displayedArtwork'
import { viewportArtworkQueue } from '../../utils/viewportArtworkQueue'

interface ArtworkImageProps {
  hash: string | null | undefined
  variant: ArtworkVariant
  alt: string
  className: string
  placeholderClassName: string
  children: ReactNode
}

type LoadResult = { url: string; loaded: boolean }

function PendingArtwork({ url, className, children, onResult }: {
  url: string
  className: string
  children: ReactNode
  onResult: (result: LoadResult) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) {
      return viewportArtworkQueue.watch(ref.current, url, loaded => onResult({ url, loaded }))
    }
  }, [url, onResult])
  return <div ref={ref} className={className} aria-hidden="true">{children}</div>
}

export default function ArtworkImage({ hash, variant, alt, className, placeholderClassName, children }: ArtworkImageProps) {
  const url = hash ? buildArtworkProtocolUrl(hash, variant) : null
  const [result, setResult] = useState<LoadResult | null>(null)
  if (!url || (result?.url === url && !result.loaded)) {
    return <div className={placeholderClassName} aria-hidden="true">{children}</div>
  }

  // Virtualized local rows can go straight to Chromium's lazy image loader.
  // Only a remote reference that may need the network goes through the queue.
  if (hash?.startsWith(SUBSONIC_ARTWORK_HASH_PREFIX) && result?.url !== url && !hasDisplayedArtwork(url)) {
    return (
      <PendingArtwork key={url} url={url} className={placeholderClassName} onResult={setResult}>
        {children}
      </PendingArtwork>
    )
  }
  return (
    <img
      src={url} alt={alt} className={className} loading="lazy" decoding="async"
      onLoad={() => rememberDisplayedArtwork(url)}
      onError={() => {
        forgetDisplayedArtwork(url)
        setResult({ url, loaded: false })
      }}
    />
  )
}
