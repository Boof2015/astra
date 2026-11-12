// URL-only hints, not image/bitmap storage. Chromium still owns decoded images.
// Remembering successful display lets remounted cards skip their placeholder
// and second Image preload. Failed/deleted files drop the hint on error.
const displayed = new Set<string>()
export function hasDisplayedArtwork(url: string | null): boolean { return !!url && displayed.has(url) }
export function rememberDisplayedArtwork(url: string): void {
  displayed.delete(url)
  displayed.add(url)
  if (displayed.size > 2048) displayed.delete(displayed.values().next().value!)
}
export function forgetDisplayedArtwork(url: string): void { displayed.delete(url) }
