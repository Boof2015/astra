import { DEFAULT_NOTCH_PREFS, NOTCH_SIZE, type NotchPrefs, type NotchPointer, type NotchPresentation } from '../../types/notch.ts'
import type { MiniPlayerSnapshot } from '../../types/miniPlayer'
import { NotchHoverIntent } from './notchHoverIntent.ts'

export function normalizeNotchPrefs(value: unknown): NotchPrefs {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const bool = (key: keyof NotchPrefs): boolean => typeof raw[key] === 'boolean'
    ? raw[key] as boolean : DEFAULT_NOTCH_PREFS[key] as boolean
  return {
    enabled: bool('enabled'), hoverEnabled: bool('hoverEnabled'),
    trackChangePopups: bool('trackChangePopups'), showOverFullscreen: bool('showOverFullscreen'),
    restingView: ['hidden', 'metadata', 'oscilloscope', 'spectrum'].includes(String(raw.restingView))
      ? raw.restingView as NotchPrefs['restingView'] : 'hidden',
  }
}

// Clock and input are explicit so timer races can be exercised without Electron.
export class NotchInteraction {
  prefs: NotchPrefs
  private expanded = false
  private hovered = false
  private suppressed = false
  private near = false
  private approach = 0
  private intent = new NotchHoverIntent()
  private leaveAt: number | null = null
  private popupUntil: number | null = null
  private initialized = false
  private trackKey: string | null = null
  private pendingTrackPopup = false
  private mainWindowForeground = false

  constructor(prefs: NotchPrefs) { this.prefs = prefs }

  configure(prefs: NotchPrefs): void {
    this.prefs = prefs
    if (!prefs.hoverEnabled) { this.hovered = false; this.approach = 0; this.intent.reset(); this.leaveAt = null }
    if (!prefs.trackChangePopups) { this.popupUntil = null; this.pendingTrackPopup = false }
  }

  setMainWindowForeground(foreground: boolean): void {
    this.mainWindowForeground = foreground
    if (foreground) {
      // These track changes are already visible in Astra. Discard them rather
      // than deferring a popup until the user switches to another application.
      this.popupUntil = null; this.pendingTrackPopup = false
    }
  }

  snapshot(snapshot: MiniPlayerSnapshot, now: number, allowPopup = true): void {
    const key = snapshot.currentTrack?.path ?? null
    if (this.initialized && key !== this.trackKey) this.pendingTrackPopup = key !== null && allowPopup && !this.mainWindowForeground
    this.initialized = true
    this.trackKey = key
    if (!key) { this.popupUntil = null; this.pendingTrackPopup = false }
    if (this.pendingTrackPopup && snapshot.playbackState === 'playing') {
      if (allowPopup && this.prefs.trackChangePopups && !this.expanded) this.popupUntil = now + 3000
      this.pendingTrackPopup = false
    }
  }

  pointer(pointer: NotchPointer, now: number): void {
    this.near = pointer.near || pointer.inside || pointer.withinHover
    if (!this.near) this.suppressed = false
    if (pointer.down && !pointer.inside && this.expanded) this.collapse()
    const eligible = pointer.onActiveSpace && !pointer.dragging && !this.suppressed && this.prefs.hoverEnabled && !this.expanded
    this.approach = eligible && pointer.near ? Math.max(0, Math.min(1, pointer.proximity)) : 0
    // Only the fixed approach zone can initiate a reveal. Animated edges and the
    // forgiving exit buffer can retain an existing preview, never start one.
    if (eligible && (pointer.near || (this.hovered && this.near))) {
      this.leaveAt = null
      if (!this.hovered) {
        const persistent = this.trackKey && !this.mainWindowForeground && this.prefs.restingView !== 'hidden'
        this.intent.update(pointer, now, persistent ? NOTCH_SIZE.previewHeight : 12)
      }
    } else {
      this.intent.reset()
      if (this.hovered && this.leaveAt === null) this.leaveAt = now + 200
    }
  }

  expand(): void { this.expanded = true; this.popupUntil = null; this.intent.reset() }
  collapse(): void {
    this.expanded = false; this.hovered = false; this.suppressed = this.near
    this.approach = 0; this.intent.reset(); this.leaveAt = null; this.popupUntil = null
  }
  tick(now: number): void {
    if (this.intent.deadline !== null && now >= this.intent.deadline) {
      this.hovered = true; this.intent.reset()
    }
    if (this.leaveAt !== null && now >= this.leaveAt) { this.hovered = false; this.leaveAt = null }
    if (this.popupUntil !== null && now >= this.popupUntil) this.popupUntil = null
  }
  get deadline(): number | null {
    const times = [this.intent.deadline, this.leaveAt, this.popupUntil].filter((n): n is number => n !== null)
    return times.length ? Math.min(...times) : null
  }
  get presentation(): NotchPresentation {
    if (this.expanded) return { view: 'expanded', reason: 'expanded' }
    if (this.hovered) return { view: 'metadata', reason: 'hover' }
    if (this.popupUntil !== null) return { view: 'metadata', reason: 'notification' }
    const resting = this.trackKey && !this.mainWindowForeground ? this.prefs.restingView : 'hidden'
    if (resting === 'hidden' && this.approach > 0) return { view: 'peek', reason: 'proximity' }
    return { view: resting, reason: 'resting' }
  }
  get proximity(): number { return this.presentation.view === 'peek' ? this.approach : 0 }
}
