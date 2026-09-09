import type { NotchPointer } from '../../types/notch'

interface Sample { x: number; y: number; distance: number; at: number }

// Proximity can hold a peek forever. A recent inward approach to the hardware
// edge (or a persistent strip) earns a brief, cancellable reveal confirmation.
export class NotchHoverIntent {
  private samples: Sample[] = []
  private committed: Sample | null = null
  deadline: number | null = null

  reset(): void { this.samples = []; this.committed = null; this.deadline = null }

  update(pointer: NotchPointer, now: number, targetDepth = 12): void {
    if (!pointer.near || pointer.y < 0 || ![pointer.x, pointer.y, pointer.edgeDistance].every(Number.isFinite)) {
      this.reset(); return
    }
    if (this.committed && pointer.edgeDistance > targetDepth) this.reset()
    // Animation-driven hit-test/Space reports cannot invent a trajectory or
    // erase one already observed. A parked cursor supplies no new evidence.
    if (!pointer.motion) return
    const sample = { x: pointer.x, y: pointer.y, distance: pointer.edgeDistance, at: now }
    const previous = this.samples.at(-1)
    // Keep a continuous gesture, including slow approaches. After a pause, only
    // the last position is relevant; old travel cannot contribute to intent.
    if (previous && now - previous.at > 200) this.samples = [previous]
    if (previous && Math.hypot(sample.x - previous.x, sample.y - previous.y) < 0.5) return
    this.samples.push(sample)
    if (this.samples.length > 32) this.samples.shift()

    if (this.committed) {
      const inward = this.committed.distance - sample.distance
      const sideways = Math.abs(sample.x - this.committed.x)
      if (sample.distance > targetDepth || inward < -2 || (sideways > 6 && inward < sideways * 0.5)) {
        // A changed destination cancels the pending reveal. Its old approach
        // must not re-arm it when the cursor stops on a neighbouring control.
        this.reset(); this.samples.push(sample); return
      }
      // Continuing toward the chosen target confirms intent; it must not keep
      // restarting a settle timer and require the cursor to come to a full stop.
      return
    }

    if (previous) {
      const step = Math.hypot(sample.x - previous.x, sample.y - previous.y)
      if (previous.distance - sample.distance < step * 0.5) {
        // Heading across or away from the edge starts a new possible gesture.
        // Earlier upward travel must not arm a reveal after turning onto a tab.
        this.samples = [sample]; return
      }
    }
    let travel = 0
    for (let i = 1; i < this.samples.length; i++) {
      travel += Math.hypot(this.samples[i].x - this.samples[i - 1].x, this.samples[i].y - this.samples[i - 1].y)
    }
    const inward = this.samples[0].distance - sample.distance
    if (sample.distance <= targetDepth && inward >= 6 && inward >= travel * 0.6) {
      this.committed = sample
      this.deadline = now + 50
    }
  }
}
