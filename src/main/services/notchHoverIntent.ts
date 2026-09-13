import type { NotchPointer } from '../../types/notch'

interface Sample { x: number; y: number; distance: number; at: number }

// Proximity can hold a peek forever. A recent inward approach to the hardware
// edge (or a persistent strip) earns a brief, cancellable reveal confirmation.
export class NotchHoverIntent {
  private samples: Sample[] = []
  private directionAnchor: Sample | null = null
  private committed: Sample | null = null
  private approachDeadline: number | null = null
  private hardwareDeadline: number | null = null

  get deadline(): number | null {
    const times = [this.approachDeadline, this.hardwareDeadline].filter((n): n is number => n !== null)
    return times.length ? Math.min(...times) : null
  }

  reset(): void {
    this.samples = []; this.directionAnchor = null; this.committed = null
    this.approachDeadline = null; this.hardwareDeadline = null
  }

  update(pointer: NotchPointer, now: number, targetDepth = 16): void {
    if (!pointer.near || (pointer.y < 0 && !pointer.overHardware) || ![pointer.x, pointer.y, pointer.edgeDistance].every(Number.isFinite)) {
      this.reset(); return
    }
    if (this.committed && pointer.edgeDistance > targetDepth) this.reset()
    if (!pointer.overHardware) this.hardwareDeadline = null
    // Animation-driven hit-test/Space reports cannot invent a trajectory or
    // erase one already observed. A parked cursor supplies no new evidence.
    if (!pointer.motion) return
    // Preserve upward progress after crossing the lower edge into the hardware.
    const sample = { x: pointer.x, y: pointer.y, distance: pointer.overHardware ? pointer.y : pointer.edgeDistance, at: now }
    const previous = this.samples.at(-1)
    // Keep a continuous gesture, including slow approaches. After a pause, only
    // the last position is relevant; old travel cannot contribute to intent.
    if (previous && now - previous.at > 200) { this.samples = [previous]; this.directionAnchor = previous }
    if (previous && Math.hypot(sample.x - previous.x, sample.y - previous.y) < 0.5) return
    // A direct arrival can skip every approach sample. Only the actual camera
    // gap offers this fallback; motion keeps deferring it during a crossing.
    if (pointer.overHardware) this.hardwareDeadline = now + 150
    this.samples.push(sample)
    if (this.samples.length > 32) this.samples.shift()
    if (!this.directionAnchor) this.directionAnchor = sample

    if (this.committed) {
      const inward = this.committed.distance - sample.distance
      const sideways = Math.abs(sample.x - this.committed.x)
      if (sample.distance > targetDepth || inward < -4 || (sideways > 10 && inward < sideways * 0.35)) {
        // A changed destination cancels the pending reveal. Its old approach
        // must not re-arm it when the cursor stops on a neighbouring control.
        const hardwareDeadline = this.hardwareDeadline
        this.reset(); this.hardwareDeadline = hardwareDeadline
        this.samples.push(sample); this.directionAnchor = sample; return
      }
      // Continuing toward the chosen target confirms intent; it must not keep
      // restarting a settle timer and require the cursor to come to a full stop.
      return
    }

    {
      const step = Math.hypot(sample.x - this.directionAnchor.x, sample.y - this.directionAnchor.y)
      // Judge direction over a short segment, not each mouse packet. Natural
      // diagonal/curved approaches include small lateral aiming corrections.
      if (step >= 6 && this.directionAnchor.distance - sample.distance < step * 0.35) {
        // Heading across or away from the edge starts a new possible gesture.
        // Earlier upward travel must not arm a reveal after turning onto a tab.
        this.samples = [sample]; this.directionAnchor = sample; return
      }
      if (step >= 6) this.directionAnchor = sample
    }
    let travel = 0
    for (let i = 1; i < this.samples.length; i++) {
      travel += Math.hypot(this.samples[i].x - this.samples[i - 1].x, this.samples[i].y - this.samples[i - 1].y)
    }
    const inward = this.samples[0].distance - sample.distance
    if (sample.distance <= targetDepth && inward >= 4 && inward >= travel * 0.35) {
      this.committed = sample
      this.approachDeadline = now + 50
    }
  }
}
