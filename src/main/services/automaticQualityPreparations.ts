import { isAutomaticStreamingQuality, isStreamingQualityRequest, type StreamingQualityRequest } from '../../types/streamingQuality'
import type { RemoteAudioLease } from './remoteAudioCache'

interface Preparation { id: string; controller: AbortController; lease?: RemoteAudioLease; previous?: RemoteAudioLease; timer: ReturnType<typeof setTimeout> }

/** Hold a candidate while it is proved decodable at the current position.
 * The old playback lease stays owned by its normal playback route throughout.
 */
export class AutomaticQualityPreparations {
  private owners = new Map<number, Preparation>()
  private options: {
    acquire: (path: string, signal: AbortSignal, request: StreamingQualityRequest) => Promise<RemoteAudioLease>
    prime: (lease: RemoteAudioLease, position: number, signal: AbortSignal) => Promise<void>
  }
  constructor(options: AutomaticQualityPreparations['options']) { this.options = options }

  async prepare(owner: number, id: string, path: string, request: StreamingQualityRequest, position: number,
    previous?: StreamingQualityRequest): Promise<{ complete: boolean }> {
    if (typeof id !== 'string' || !id || id.length > 128 || typeof path !== 'string'
      || !Number.isFinite(position) || position < 0 || !isStreamingQualityRequest(request)
      || typeof request !== 'object' || !isAutomaticStreamingQuality(request.mode)) throw new Error('Invalid automatic quality preparation.')
    if (previous !== undefined && !isStreamingQualityRequest(previous)) throw new Error('Invalid current streaming quality.')
    this.releaseOwner(owner)
    const preparation: Preparation = { id, controller: new AbortController(),
      timer: setTimeout(() => this.release(owner, id), 30_000) }
    preparation.timer.unref()
    this.owners.set(owner, preparation)
    try {
      if (previous !== undefined) preparation.previous = await this.options.acquire(path, preparation.controller.signal, previous)
      preparation.controller.signal.throwIfAborted()
      preparation.lease = await this.options.acquire(path, preparation.controller.signal, request)
      preparation.controller.signal.throwIfAborted()
      await this.options.prime(preparation.lease, position, preparation.controller.signal)
      preparation.controller.signal.throwIfAborted()
      return { complete: preparation.lease.progress().complete }
    } catch {
      if (this.owners.get(owner) === preparation) this.release(owner, id)
      else { preparation.lease?.release(); preparation.previous?.release() }
      // Never forward ffmpeg errors containing an internal capability URL.
      throw new Error('Automatic quality preparation was cancelled or could not finish.')
    }
  }

  release(owner: number, id: string): void {
    const preparation = this.owners.get(owner)
    if (preparation?.id !== id) return
    this.owners.delete(owner)
    clearTimeout(preparation.timer)
    preparation.controller.abort()
    preparation.lease?.release()
    preparation.previous?.release()
  }

  releaseOwner(owner: number): void {
    const preparation = this.owners.get(owner)
    if (preparation) this.release(owner, preparation.id)
  }
}
