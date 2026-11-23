import { hasDisplayedArtwork, rememberDisplayedArtwork } from './displayedArtwork'
import { preloadArtwork } from './preloadArtwork'

type ArtworkRequest = {
  url: string
  complete: (loaded: boolean) => void
}

/** Only visible, unresolved covers may start a request. An active image load
 * owns its slot until it settles, even if React recycles the requesting row. */
export class ViewportArtworkQueue {
  private readonly requests = new Map<Element, ArtworkRequest>()
  private readonly visible = new Set<Element>()
  private readonly active = new Map<string, Promise<boolean>>()
  private observer?: IntersectionObserver
  private readonly load: (url: string) => Promise<unknown>
  private readonly limit: number

  constructor(load: (url: string) => Promise<unknown> = preloadArtwork, limit = 6) {
    this.load = load
    this.limit = limit
  }

  watch(element: Element, url: string, complete: ArtworkRequest['complete']): () => void {
    this.requests.set(element, { url, complete })
    if (typeof IntersectionObserver === 'undefined') {
      this.visible.add(element)
      this.drain()
    } else {
      this.observer ??= new IntersectionObserver(entries => {
        for (const { target, isIntersecting } of entries) {
          if (!this.requests.has(target)) continue
          if (isIntersecting) this.visible.add(target)
          else this.visible.delete(target)
        }
        this.drain()
      })
      this.observer.observe(element)
    }
    return () => {
      this.observer?.unobserve(element)
      this.visible.delete(element)
      this.requests.delete(element)
    }
  }

  private drain(): void {
    for (const element of this.visible) {
      const request = this.requests.get(element)!
      let job = this.active.get(request.url)
      if (!job && !hasDisplayedArtwork(request.url)) {
        if (this.active.size >= this.limit) continue
        job = this.load(request.url).then(() => {
          rememberDisplayedArtwork(request.url)
          return true
        }, () => false).finally(() => {
          this.active.delete(request.url)
          this.drain()
        })
        this.active.set(request.url, job)
      }
      this.visible.delete(element)
      this.observer?.unobserve(element)
      if (job) {
        void job.then(loaded => {
          if (this.requests.get(element) === request) request.complete(loaded)
        })
      } else {
        request.complete(true)
      }
    }
  }
}

export const viewportArtworkQueue = new ViewportArtworkQueue()
