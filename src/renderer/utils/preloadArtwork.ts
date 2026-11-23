export function preloadArtwork(url: string): Promise<string> {
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
