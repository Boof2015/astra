export type ProgressiveStreamSlot = 'current' | 'next'

/** Preparing a successor must never cancel the track the user is starting. */
export class ProgressiveStartupRegistry {
  private readonly pending = new Map<string, AbortController>()

  begin(senderId: number, slot: ProgressiveStreamSlot, preserveNext = false): AbortController {
    this.cancel(senderId, slot)
    if (slot === 'current' && !preserveNext) this.cancel(senderId, 'next')
    const controller = new AbortController()
    this.pending.set(`${senderId}:${slot}`, controller)
    return controller
  }

  cancel(senderId: number, slot: ProgressiveStreamSlot): void {
    this.pending.get(`${senderId}:${slot}`)?.abort()
  }

  finish(senderId: number, slot: ProgressiveStreamSlot, controller: AbortController): void {
    const key = `${senderId}:${slot}`
    if (this.pending.get(key) === controller) this.pending.delete(key)
  }

  cancelAll(): void {
    for (const controller of this.pending.values()) controller.abort()
    this.pending.clear()
  }
}
