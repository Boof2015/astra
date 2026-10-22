import { createHash } from 'node:crypto'
import type { AudioTransferEvent } from './automaticStreamingQuality.ts'
import type { AutomaticStreamingQuality as QualityMode, RemotePlaybackQuality, StreamQualityTarget } from '../../types/streamingQuality.ts'
import type { StratumProofQuality, StratumProofSource } from './stratumProofClient.ts'
import { isStratumRefusal } from './stratumProofTransport.ts'

export const stratumTarget = (quality: StratumProofQuality): StreamQualityTarget =>
  quality === 'lossless' ? 'original' : quality === 'opus-64' ? 64 : 128

export function stratumPlaybackQuality(source: StratumProofSource, quality: StratumProofQuality, mode?: QualityMode): RemotePlaybackQuality {
  return { transport: 'stratum', requested: stratumTarget(quality), ...(mode ? { mode } : {}),
    requestedCodec: quality === 'lossless' ? 'flac' : 'opus',
    delivered: { codec: quality === 'lossless' ? 'flac' : 'opus',
      sampleRate: quality === 'lossless' ? source.sample_rate : 48000, channels: source.channels,
      bitDepth: quality === 'lossless' ? source.bits_per_sample : null,
      // Target bitrate is not a measurement of a short VBR response.
      bitrateKbps: null } }
}

const LADDER: readonly StratumProofQuality[] = ['opus-64', 'opus-128', 'lossless']
export const stratumQualityRank = (quality: StratumProofQuality) => LADDER.indexOf(quality)
const rank = stratumQualityRank
// Ogg pages add about 7% to the nominal Opus rate (measured 68.6 and 135 kbps).
const OPUS_KBPS = { 'opus-64': 64 * 1.08, 'opus-128': 128 * 1.08 } as const
const ESTIMATE_LIFETIME_MS = 5 * 60_000
// Sidecar's fixed interval length. Sustainability is judged over a full interval
// so that a track's short final interval is not mistaken for a slow link.
const INTERVAL_SECONDS = 4
// A remembered (not fresh) link estimate must clear this much extra headroom.
const HINT_MARGIN = 1.25

/** Per-mode tolerances. Headroom: an interval must arrive this many times faster
 * than it plays. Upgrades need extra margin and enough buffered audio. */
const POLICY = {
  automatic: { headroom: 1.5, upMargin: 1.2, upBuffer: 20 },
  'automatic-original': { headroom: 1.25, upMargin: 1.1, upBuffer: 12 }
} as const

// Averages are of time per kilobit (a harmonic mean): one slow transfer pulls the
// estimate down immediately, while recovery needs several fast ones.
interface Estimate { fastSecondsPerKbit: number; slowSecondsPerKbit: number; overheadMs: number; at: number }
interface Link { kbps: number; overheadMs: number }
interface HintStore { read(): string | null; write(value: string): Promise<void> | void }
const HINT_LIFETIME_MS = 30 * 24 * 60 * 60_000
const HINT_LIMIT = 16
// Saved hints are keyed by digest: a development key can contain a bearer.
const hintKey = (key: string) => createHash('sha256').update(key).digest('hex')

/** Link evidence per Sidecar account. Current and next playback share it, and a
 * cold start may use it while it is fresh. Only network transfers update it.
 * The last estimate also survives pauses and, once a store is attached,
 * restarts, as a weaker hint for a cold start's first choice. */
export class StratumLinkEstimates {
  private readonly values = new Map<string, Estimate>()
  private readonly hints = new Map<string, Link & { savedAt: number }>()
  private readonly now: () => number
  private readonly wallNow: () => number
  private store?: HintStore
  private loaded = false
  private saveTimer?: ReturnType<typeof setTimeout>
  constructor(now: () => number = () => performance.now(), wallNow: () => number = () => Date.now()) {
    this.now = now
    this.wallNow = wallNow
  }

  attach(store: HintStore): void { this.store = store; this.loaded = false }

  get(key: string): Link | null {
    const value = this.values.get(key)
    if (!value || this.now() - value.at > ESTIMATE_LIFETIME_MS) return null
    return { kbps: 1 / Math.max(value.fastSecondsPerKbit, value.slowSecondsPerKbit), overheadMs: value.overheadMs }
  }
  /** The last known estimate when no fresh one exists: from this session at any
   * age, otherwise saved within 30 days. */
  hint(key: string): Link | null {
    const value = this.values.get(key)
    if (value && Number.isFinite(value.fastSecondsPerKbit)) {
      return { kbps: 1 / Math.max(value.fastSecondsPerKbit, value.slowSecondsPerKbit), overheadMs: value.overheadMs }
    }
    this.load()
    const saved = this.hints.get(hintKey(key))
    return saved && this.wallNow() - saved.savedAt <= HINT_LIFETIME_MS ? { kbps: saved.kbps, overheadMs: saved.overheadMs } : null
  }
  body(key: string, kbps: number): void {
    if (!(kbps > 0)) return
    const cost = 1 / kbps
    const value = this.values.get(key)
    const fresh = value && this.now() - value.at <= ESTIMATE_LIFETIME_MS
    this.values.set(key, fresh
      ? { ...value, fastSecondsPerKbit: value.fastSecondsPerKbit * .5 + cost * .5, slowSecondsPerKbit: value.slowSecondsPerKbit * .8 + cost * .2, at: this.now() }
      : { fastSecondsPerKbit: cost, slowSecondsPerKbit: cost, overheadMs: value?.overheadMs ?? 0, at: this.now() })
    this.remember(key)
  }
  overhead(key: string, ms: number): void {
    const value = this.values.get(key)
    if (!value) { this.values.set(key, { fastSecondsPerKbit: Infinity, slowSecondsPerKbit: Infinity, overheadMs: ms, at: -Infinity }); return }
    value.overheadMs = value.overheadMs ? value.overheadMs * .7 + ms * .3 : ms
  }

  private load(): void {
    if (this.loaded || !this.store) return
    this.loaded = true
    try {
      const raw = this.store.read()
      const value = raw && raw.length <= 64 * 1024 ? JSON.parse(raw) : null
      if (value?.version !== 1 || !value.links || typeof value.links !== 'object') return
      for (const [key, link] of Object.entries(value.links as Record<string, Partial<Link & { savedAt: number }>>)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !(Number(link?.kbps) > 0) || !(Number(link?.overheadMs) >= 0)
          || !Number.isFinite(link?.savedAt)) continue
        this.hints.set(key, { kbps: Number(link.kbps), overheadMs: Number(link.overheadMs), savedAt: Number(link.savedAt) })
      }
    } catch { /* A damaged hint only means a cold start. */ }
  }
  private remember(key: string): void {
    const link = this.get(key)
    if (!link || !this.store) return
    this.load()
    const digest = hintKey(key)
    this.hints.delete(digest)
    this.hints.set(digest, { ...link, savedAt: this.wallNow() })
    while (this.hints.size > HINT_LIMIT) this.hints.delete(this.hints.keys().next().value!)
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => this.flush(), 10_000)
    this.saveTimer.unref?.()
  }
  flush(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    if (!this.store || !this.loaded) return
    void Promise.resolve(this.store.write(JSON.stringify({ version: 1, links: Object.fromEntries(this.hints) }))).catch(() => {})
  }
}
export const stratumLinkEstimates = new StratumLinkEstimates()

/** Authorization and format refusals cannot be fixed by asking again. */
function retryable(error: unknown): boolean {
  return !isStratumRefusal(error) && !(error instanceof Error && error.message === 'Stratum playback was released.')
}

/** Stratum-native automatic quality. Each interval is chosen from what it costs
 * to fetch (request overhead plus its bytes at the measured rate) against how
 * long it plays and how much audio is buffered. No wall-clock cooldowns: buffer
 * thresholds and upgrade margins provide hysteresis. An in-flight interval is
 * abandoned for a lower one whenever it would arrive after the buffer runs out
 * and the lower interval, including a new connection, would arrive sooner. */
export class StratumQualityController {
  private current: StratumProofQuality
  private first = true
  private samplesSinceChange = 0
  private losslessKbps: number
  private readonly options: {
    mode: QualityMode; key: string; source: StratumProofSource; initial: StratumProofQuality
    pinInitial?: boolean
    buffer: () => { position: number; ahead: number }
    now?: () => number
    estimates?: StratumLinkEstimates
  }
  constructor(options: StratumQualityController['options']) {
    this.options = options
    this.current = options.initial
    // FLAC usually stores 50–70% of PCM. Assume the expensive end until measured.
    this.losslessKbps = options.source.sample_rate * options.source.channels * options.source.bits_per_sample / 1000 * .75
  }
  private now() { return this.options.now?.() ?? performance.now() }
  private get estimates() { return this.options.estimates ?? stratumLinkEstimates }
  private get policy() { return POLICY[this.options.mode] }
  private seconds(frames: number) { return frames / this.options.source.sample_rate }
  private bits(quality: StratumProofQuality, seconds: number) {
    return (quality === 'lossless' ? this.losslessKbps : OPUS_KBPS[quality]) * 1000 * seconds
  }
  /** Seconds to fetch an interval: request overhead plus its body. */
  private cost(quality: StratumProofQuality, seconds: number, link: { kbps: number; overheadMs: number }) {
    return link.overheadMs / 1000 + this.bits(quality, seconds) / Math.max(1, link.kbps * 1000)
  }
  private sustainable(link: { kbps: number; overheadMs: number }, margin = 1) {
    return [...LADDER].reverse().find(quality =>
      this.cost(quality, INTERVAL_SECONDS, link) * this.policy.headroom * margin <= INTERVAL_SECONDS) ?? LADDER[0]
  }
  private set(quality: StratumProofQuality) {
    if (quality !== this.current) this.samplesSinceChange = 0
    this.current = quality
  }

  choose(frames: number): StratumProofQuality {
    const seconds = this.seconds(frames)
    const link = this.estimates.get(this.options.key)
    if (this.first) {
      this.first = false
      // A seek keeps its pinned representation. Without fresh evidence, the last
      // known link (with extra headroom) or else Opus 128 starts the track. A
      // wrong hint costs one abandoned interval, priced from its own transfer.
      if (!this.options.pinInitial) {
        const hint = link ?? this.estimates.hint(this.options.key)
        this.set(hint ? this.sustainable(hint, link ? 1 : HINT_MARGIN) : 'opus-128')
      }
      return this.current
    }
    if (!link) return this.current
    const ahead = this.options.buffer().ahead
    let target = this.sustainable(link)
    // The next interval must arrive before the buffered audio runs out.
    if (this.cost(this.current, seconds, link) > ahead - 1) {
      const fits = [...LADDER].reverse().find(quality => this.cost(quality, seconds, link) <= Math.max(0, ahead - 1)) ?? LADDER[0]
      if (rank(fits) < rank(target)) target = fits
    }
    if (rank(target) < rank(this.current)) { this.set(target); return this.current }
    if (rank(target) > rank(this.current)) {
      const up = LADDER[rank(this.current) + 1]
      const cost = this.cost(up, INTERVAL_SECONDS, link)
      const needed = Math.min(this.policy.upBuffer, Math.max(INTERVAL_SECONDS, 4 * cost))
      if (this.samplesSinceChange >= 2 && ahead >= needed && cost * this.policy.headroom * this.policy.upMargin <= INTERVAL_SECONDS) this.set(up)
    }
    return this.current
  }

  /** Seconds until playback reaches a source frame; 0 when it is already due. */
  secondsUntil(start: number): number {
    return Math.max(0, start / this.options.source.sample_rate - this.options.buffer().position)
  }

  /** Whether the link now justifies fetching better than a retained interval,
   * with the same margin as an upgrade. */
  prefers(retained: StratumProofQuality): boolean {
    const fresh = this.estimates.get(this.options.key)
    const link = fresh ?? this.estimates.hint(this.options.key)
    return !!link && rank(this.sustainable(link, (fresh ? 1 : HINT_MARGIN) * this.policy.upMargin)) > rank(retained)
  }

  /** Runs one interval's attempts. A failed or abandoned request moves down a
   * rung (or retries the lowest) instead of repeating the same cost. With the
   * interval's source frame, its deadline is when playback reaches it. */
  async fetch<T>(frames: number, quality: StratumProofQuality, signal: AbortSignal,
    read: (quality: StratumProofQuality, signal: AbortSignal, timing?: ReturnType<StratumQualityController['begin']>) => Promise<T>,
    start?: number): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted()
      const controller = new AbortController()
      let replacement: StratumProofQuality | undefined
      const timing = this.begin(frames, quality, lower => { replacement = lower; controller.abort() }, start)
      try { return await read(quality, AbortSignal.any([signal, controller.signal]), timing) }
      catch (error) {
        signal.throwIfAborted()
        timing.failed()
        if (attempt >= 3 || (!replacement && !retryable(error))) throw error
        quality = replacement ?? LADDER[Math.max(0, rank(quality) - 1)]
        if (rank(quality) < rank(this.current)) this.set(quality)
      } finally { timing.close() }
    }
  }

  begin(frames: number, quality: StratumProofQuality, abandon?: (lower: StratumProofQuality) => void, start?: number) {
    const seconds = this.seconds(frames)
    const started = this.now()
    let headersAt: number | null = null
    let lastByteAt = started, lastCheck = started, received = 0, settled = false
    const check = () => {
      if (!abandon || settled) return
      const now = this.now()
      lastCheck = now
      const link = this.estimates.get(this.options.key)
      // A cold start has no shared estimate yet; this request's own wait still
      // prices a replacement, which also needs a new connection.
      const overheadMs = Math.max(link?.overheadMs ?? 0, (headersAt ?? now) - started)
      const bodyMs = headersAt === null ? 0 : now - headersAt
      const kbps = headersAt !== null && received >= 8192 && bodyMs >= 250 ? received * 8 / bodyMs : link?.kbps
      // Upgrading a retained interval must not borrow the audio retained after it.
      const ahead = start === undefined ? this.options.buffer().ahead : this.secondsUntil(start)
      // Silence on a congested link is usually queueing, and a new request loses
      // its place: wait at least 8 s, more with buffer. Prior evidence only, or
      // waiting would extend itself. A dead connection meets the transport deadline.
      const stalled = now - lastByteAt > Math.max(8000, 3 * (link?.overheadMs ?? 0), Math.min(10_000, ahead * 500))
      if (!stalled && !kbps) return
      const waiting = headersAt === null ? Math.max(0, overheadMs - (now - started)) / 1000 : 0
      const remaining = stalled ? Infinity : waiting + Math.max(0, this.bits(quality, seconds) - received * 8) / (kbps! * 1000)
      if (remaining <= ahead - 1) return
      const rate = { kbps: kbps ?? link?.kbps ?? 1, overheadMs }
      const reconnect = 2 * overheadMs / 1000
      const lower = LADDER.slice(0, rank(quality)).reverse()
        .find(candidate => this.cost(candidate, seconds, rate) + reconnect < remaining)
      if (lower) { settled = true; abandon(lower) }
    }
    const watchdog = abandon ? setInterval(check, 500) : undefined
    watchdog?.unref?.()
    return {
      observe: (event: AudioTransferEvent) => {
        const now = this.now()
        if (event.phase === 'start') {
          headersAt = now
          lastByteAt = now
          this.estimates.overhead(this.options.key, now - started)
        }
        if (event.phase === 'data') {
          received += event.bytes ?? 0
          lastByteAt = now
          if (now - lastCheck >= 250) check()
        }
      },
      ready: (actual: StratumProofQuality, readyFrames: number, bytes: number) => {
        settled = true
        const media = this.seconds(readyFrames)
        const bodyMs = headersAt === null ? 0 : this.now() - headersAt
        if (bytes >= 16 * 1024 || bodyMs >= 250) this.estimates.body(this.options.key, bytes * 8 / Math.max(20, bodyMs))
        // A track's short final interval is mostly container overhead.
        if (actual === 'lossless' && media >= 1) this.losslessKbps = this.losslessKbps * .5 + bytes * 8 / media / 1000 * .5
        this.samplesSinceChange++
      },
      /** A partial transfer still measured the link; an unanswered one measured its wait. */
      failed: () => {
        settled = true
        const now = this.now()
        if (headersAt === null) { if (now - started >= 1000) this.estimates.overhead(this.options.key, now - started); return }
        // Same evidence an abandonment decision uses, so the next choice sees it too.
        if (received >= 8192 && now - headersAt >= 250) this.estimates.body(this.options.key, received * 8 / (now - headersAt))
      },
      close: () => { settled = true; if (watchdog) clearInterval(watchdog) }
    }
  }
}
