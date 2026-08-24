import { buildAlbumKey, normalizeKey } from './albumIdentity'

export type LibraryScrollViewMode = 'tracks' | 'albums' | 'artists' | 'genres' | 'years' | 'folders'
export type LibraryScrollYearKey = number | 'unknown'
export type LibraryScrollContextKey = `root:${LibraryScrollViewMode}` | `detail:${string}`

export interface LibraryScrollContext {
  viewMode: LibraryScrollViewMode
  selectedAlbum: { identity_key?: string; album: string; artist: string } | null
  selectedArtist: string | null
  selectedGenre: string | null
  selectedYear: LibraryScrollYearKey | null
}

export interface LibraryScrollViewport {
  clientHeight: number
  scrollHeight: number
  scrollTop: number
}

interface LibraryScrollRestoreOptions {
  cancelFrame?: (frameId: number) => void
  maxAttempts?: number
  onSettled?: () => void
  requestFrame?: (callback: FrameRequestCallback) => number
}

const RESTORE_EPSILON_PX = 1
const DEFAULT_RESTORE_ATTEMPTS = 8
const libraryScrollPositions = new Map<LibraryScrollContextKey, number>()

function normalizeScrollTop(scrollTop: number): number {
  return Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0
}

function getMaxScrollTop(viewport: LibraryScrollViewport): number {
  return Math.max(
    0,
    normalizeScrollTop(viewport.scrollHeight) - normalizeScrollTop(viewport.clientHeight)
  )
}

export function resolveLibraryScrollContextKey({
  viewMode,
  selectedAlbum,
  selectedArtist,
  selectedGenre,
  selectedYear
}: LibraryScrollContext): LibraryScrollContextKey {
  if (selectedAlbum) {
    const identityKey = selectedAlbum.identity_key?.trim()
      || buildAlbumKey(selectedAlbum.album, selectedAlbum.artist)
    return `detail:album:${identityKey}`
  }
  if (selectedArtist) return `detail:artist:${normalizeKey(selectedArtist)}`
  if (selectedGenre) return `detail:genre:${normalizeKey(selectedGenre)}`
  if (selectedYear !== null) return `detail:year:${selectedYear}`
  return `root:${viewMode}`
}

export function rememberLibraryScrollPosition(key: LibraryScrollContextKey, scrollTop: number): void {
  libraryScrollPositions.set(key, normalizeScrollTop(scrollTop))
}

export function getRememberedLibraryScrollPosition(key: LibraryScrollContextKey): number | undefined {
  return libraryScrollPositions.get(key)
}

export function clearRememberedLibraryScrollPositions(): void {
  libraryScrollPositions.clear()
}

/**
 * Restore only after the viewport has enough scroll range to honor the saved
 * offset. Virtualized grids and lists often publish their final canvas height
 * a frame or two after mounting, so an immediate assignment can clamp to zero
 * and silently discard the intended position.
 */
export function restoreLibraryScrollPosition(
  viewport: LibraryScrollViewport,
  savedScrollTop: number,
  options: LibraryScrollRestoreOptions = {}
): () => void {
  const targetScrollTop = normalizeScrollTop(savedScrollTop)
  const maxAttempts = Math.max(1, Math.round(options.maxAttempts ?? DEFAULT_RESTORE_ATTEMPTS))
  const requestFrame = options.requestFrame ?? ((callback: FrameRequestCallback) => window.requestAnimationFrame(callback))
  const cancelFrame = options.cancelFrame ?? ((frameId: number) => window.cancelAnimationFrame(frameId))
  let attempts = 0
  let consecutiveStableFrames = 0
  let frameId: number | null = null
  let canceled = false
  let settled = false

  const finish = () => {
    if (settled || canceled) return
    settled = true
    options.onSettled?.()
  }

  const scheduleAttempt = (attempt: FrameRequestCallback) => {
    frameId = requestFrame(attempt)
  }

  const attemptRestore: FrameRequestCallback = () => {
    frameId = null
    if (canceled || settled) return

    attempts += 1
    const maxScrollTop = getMaxScrollTop(viewport)

    if (targetScrollTop <= maxScrollTop + RESTORE_EPSILON_PX) {
      const desiredScrollTop = Math.min(targetScrollTop, maxScrollTop)
      viewport.scrollTop = desiredScrollTop
      consecutiveStableFrames = Math.abs(viewport.scrollTop - desiredScrollTop) <= RESTORE_EPSILON_PX
        ? consecutiveStableFrames + 1
        : 0

      // Verify on a later frame as virtualized components can reset scrollTop
      // during their own post-mount measurement render.
      if (consecutiveStableFrames >= 2 || attempts >= maxAttempts) {
        finish()
        return
      }
      scheduleAttempt(attemptRestore)
      return
    }

    consecutiveStableFrames = 0
    if (attempts >= maxAttempts) {
      viewport.scrollTop = maxScrollTop
      finish()
      return
    }
    scheduleAttempt(attemptRestore)
  }

  attemptRestore(0)

  return () => {
    canceled = true
    if (frameId !== null) {
      cancelFrame(frameId)
      frameId = null
    }
  }
}

/**
 * Bind one mounted scrollport to its runtime-only Library context. Cleanup
 * captures the final offset before the element is discarded by navigation.
 */
export function bindLibraryScrollRestoration(
  key: LibraryScrollContextKey,
  viewport: LibraryScrollViewport,
  options: LibraryScrollRestoreOptions = {}
): () => void {
  const savedScrollTop = getRememberedLibraryScrollPosition(key)
  let restorationSettled = savedScrollTop === undefined
  if (savedScrollTop === undefined) {
    // TrackList can be reused when moving between root Tracks and an album or
    // genre detail, so a brand-new context must explicitly begin at the top.
    viewport.scrollTop = 0
  }

  const eventViewport = viewport as LibraryScrollViewport & Partial<Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>>
  const recordScrollPosition = () => {
    if (!restorationSettled) return
    rememberLibraryScrollPosition(key, viewport.scrollTop)
  }
  eventViewport.addEventListener?.('scroll', recordScrollPosition, { passive: true })

  const cancelRestore = savedScrollTop === undefined
    ? () => undefined
    : restoreLibraryScrollPosition(viewport, savedScrollTop, {
      ...options,
      onSettled: () => {
        restorationSettled = true
        rememberLibraryScrollPosition(key, viewport.scrollTop)
        options.onSettled?.()
      }
    })

  return () => {
    eventViewport.removeEventListener?.('scroll', recordScrollPosition)
    cancelRestore()

    // If navigation interrupts a delayed restore while the virtual canvas is
    // still height zero, retain the old non-zero target instead of replacing
    // it with the viewport's temporary zero.
    if (!restorationSettled && savedScrollTop && viewport.scrollTop <= 0) return

    // React may remove or resize a virtual canvas before the parent's cleanup
    // runs. A user-driven return to the top has already been recorded by the
    // scroll listener; only preserve a non-zero value when the element itself
    // has temporarily lost all scroll range.
    const rememberedScrollTop = getRememberedLibraryScrollPosition(key)
    if (viewport.scrollTop <= 0 && rememberedScrollTop && getMaxScrollTop(viewport) <= 0) return
    rememberLibraryScrollPosition(key, viewport.scrollTop)
  }
}
