import {
  STREAMING_BITRATES, type AutomaticStreamingQuality as AutomaticQualityMode, type StreamQualityTarget
} from '../../types/streamingQuality'

export interface AudioTransferEvent { phase: 'start' | 'data' | 'end'; bytes?: number; complete?: boolean; totalBytes?: number }
interface Sample { at: number; ms: number; bytes: number }
interface Network {
  active: Set<symbol>; since: number; bytes: number; samples: Sample[]; completed: Sample[]; minimumSampleMs: number
}
export interface SegmentQualityConditions {
  /** Decisions belong to a playback; bandwidth can still be shared by its server. */
  decisionKey: string
  bitrates: readonly (typeof STREAMING_BITRATES[number])[]
  aheadSeconds: number
  nextSeconds: number
  overheadSeconds: number
  deliverySeconds: number
  mediaSeconds: number
  observedSeconds: number
}
interface Decision {
  target: StreamQualityTarget; changedAt: number; stressedAt: number | null; retryAt: number
  observation?: { at: number; position: number; ahead: number; drain: number }
}
export interface AutomaticQualityConditions {
  segments?: SegmentQualityConditions
  originalKbps: number
  current: StreamQualityTarget
  deliveredKbps?: number | null
  position: number
  duration: number
  bufferedSeconds: number
  loadedBytes: number
  totalBytes: number | null
  complete: boolean
}

/** Source downloads, not decoder reads or cache hits, provide bandwidth evidence.
 * Concurrent downloads share one clock and byte budget for their server account.
 */
export class AutomaticStreamingQuality {
  private networks = new Map<string, Network>()
  private decisions = new Map<string, Decision>()
  private now: () => number
  constructor(now: () => number = () => performance.now()) { this.now = now }

  observer(key: string, minimumSampleMs = 250): (event: AudioTransferEvent) => void {
    const id = Symbol()
    let startedAt = 0, received = 0
    return event => {
      const now = this.now()
      let network = this.networks.get(key)
      if (!network) {
        network = { active: new Set(), since: now, bytes: 0, samples: [], completed: [], minimumSampleMs }
        this.networks.set(key, network)
      }
      if (event.phase === 'start') {
        startedAt = now; received = 0
        if (!network.active.size) { network.since = now; network.bytes = 0 }
        network.active.add(id)
      } else if (network.active.has(id)) {
        if (event.phase === 'data') {
          const bytes = Math.max(0, event.bytes ?? 0)
          network.bytes += bytes; received += bytes
        }
        this.sample(network, now, event.phase === 'end')
        if (event.phase === 'end') {
          network.active.delete(id)
          if (event.complete !== false && received >= 16 * 1024) network.completed.push({ at: now, ms: Math.max(network.minimumSampleMs, now - startedAt), bytes: received })
          network.completed = network.completed.filter(sample => now - sample.at < 600_000).slice(-16)
        }
      }
    }
  }

  private sample(network: Network, now: number, ending = false): void {
    const ms = now - network.since
    if (ms < (ending ? network.minimumSampleMs : 1000) && !(ending && network.bytes >= 16 * 1024)) return
    network.samples.push({ at: now, ms: Math.max(ms, network.minimumSampleMs), bytes: network.bytes })
    network.samples = network.samples.filter(sample => now - sample.at < 600_000).slice(-128)
    network.since = now
    network.bytes = 0
  }

  evidence(key: string): { kbps: number; seconds: number; recoveredKbps: number } | null {
    const network = this.networks.get(key)
    if (!network) return null
    const now = this.now()
    if (network.active.size) this.sample(network, now)
    const samples = network.samples.filter(sample => now - sample.at < 20_000)
    if (!samples.length) return null
    const rate = (values: Sample[]) => values.reduce((sum, sample) => sum + sample.bytes * 8, 0)
      / values.reduce((sum, sample) => sum + sample.ms, 0)
    const recent = samples.filter(sample => now - sample.at < 5000)
    // A short burst cannot erase sustained poor delivery. Idle cached playback
    // supplies no samples and cannot establish recovery.
    const kbps = Math.min(rate(samples), recent.length ? rate(recent) : rate(samples))
    const seconds = samples.reduce((sum, sample) => sum + sample.ms, 0) / 1000
    const recovery = samples.filter(sample => now - sample.at < 15_000)
    const recoverySeconds = recovery.reduce((sum, sample) => sum + sample.ms, 0) / 1000
    // Fast connections can finish entire songs between polls. Three independently
    // completed transfers spread over at least 15 seconds also establish recovery;
    // include intervening slow samples and require fresh evidence. Cache hits never
    // enter this history. Whole-file transfers retain the 250 ms timing floor.
    // Short segment bodies can each finish in milliseconds, and the last three
    // normally span only eight seconds. Require a longer series spanning the
    // same recovery interval, without pretending idle/pacing time is transfer.
    const completed = network.minimumSampleMs < 250
      ? network.completed.filter(sample => now - sample.at <= 30_000) : network.completed.slice(-3)
    const last = completed.at(-1)
    const repeated = completed.length >= 3 && last!.at - completed[0].at >= 15_000
      && now - last!.at < 20_000
      ? Math.min(...[...completed, ...network.samples.filter(sample => sample.at >= completed[0].at)]
        .map(sample => sample.bytes * 8 / sample.ms)) : 0
    return { kbps, seconds: repeated > 0 ? Math.max(3, seconds) : seconds,
      recoveredKbps: Math.max(repeated, recoverySeconds >= 15
        ? Math.min(...recovery.map(sample => sample.bytes * 8 / sample.ms)) : 0) }
  }

  private state(key: string, mode: AutomaticQualityMode): Decision {
    const id = `${key}:${mode}`
    let state = this.decisions.get(id)
    if (!state) {
      state = { target: 'original', changedAt: -Infinity, stressedAt: null, retryAt: 0 }
      this.decisions.set(id, state)
    }
    return state
  }

  private best(kbps: number, originalKbps: number, bitrates: readonly (typeof STREAMING_BITRATES[number])[] = STREAMING_BITRATES): StreamQualityTarget {
    if (originalKbps > 0 && originalKbps <= kbps) return 'original'
    const ranked = [...bitrates].sort((a, b) => b - a)
    return ranked.find(value => value <= kbps) ?? ranked.at(-1) ?? 64
  }

  private rank(target: StreamQualityTarget): number { return target === 'original' ? Infinity : target }

  select(key: string, mode: AutomaticQualityMode, originalKbps: number,
    segments?: Pick<SegmentQualityConditions, 'decisionKey' | 'bitrates'>): StreamQualityTarget {
    const state = this.state(segments?.decisionKey ?? key, mode)
    const evidence = this.evidence(key)
    if (!evidence || evidence.seconds < 3) return state.target
    const candidate = this.best(evidence.kbps / (mode === 'automatic' ? 1.55 : 1.15), originalKbps, segments?.bitrates)
    if (this.rank(candidate) < this.rank(state.target)) return candidate
    if (this.canUpgrade(state, evidence, candidate, originalKbps)) return candidate
    return state.target
  }

  private canUpgrade(state: Decision, evidence: NonNullable<ReturnType<AutomaticStreamingQuality['evidence']>>,
    candidate: StreamQualityTarget, originalKbps: number): boolean {
    return this.now() - state.changedAt >= 30_000
      && evidence.recoveredKbps >= (candidate === 'original' ? originalKbps : candidate) * 1.75
  }

  recommend(key: string, mode: AutomaticQualityMode, conditions: AutomaticQualityConditions): StreamQualityTarget | null {
    const now = this.now()
    const segments = conditions.segments
    const state = this.state(segments?.decisionKey ?? key, mode)
    const evidence = this.evidence(key)
    if (conditions.complete || !evidence || Math.max(evidence.seconds, segments?.observedSeconds ?? 0) < 3 || now < state.retryAt
      || (!segments && conditions.duration <= conditions.position + 12)) { state.stressedAt = null; return null }
    const original = conditions.originalKbps
    const actual = conditions.deliveredKbps && conditions.deliveredKbps > 0 ? conditions.deliveredKbps
      : conditions.current === 'original' ? original : conditions.current
    if (!(actual > 0)) return null
    // Encoded lookahead matters when a bounded native PCM ring is already full.
    // Treat byte/duration estimates conservatively; decoded frames are known.
    const encodedUntil = conditions.totalBytes && conditions.duration > 0
      ? conditions.loadedBytes / conditions.totalBytes * conditions.duration
      : conditions.loadedBytes * 8 / (actual * 1000)
    const ahead = segments ? Math.max(0, segments.aheadSeconds) : Math.max(0, conditions.bufferedSeconds - conditions.position,
      (encodedUntil - conditions.position) * 0.7)
    const previous = state.observation
    const elapsed = previous ? (now - previous.at) / 1000 : 0
    const comparable = previous && elapsed > 0 && elapsed <= (segments ? Math.max(3, segments.nextSeconds * 3 + segments.overheadSeconds) : 3)
      && conditions.position >= previous.position && conditions.position - previous.position <= elapsed + 1
    const observedDrain = comparable ? previous.drain * 0.5 + Math.max(0, (previous.ahead - ahead) / elapsed) * 0.5 : 0
    state.observation = { at: now, position: conditions.position, ahead, drain: observedDrain }
    const deliveryKbps = segments && segments.deliverySeconds >= segments.mediaSeconds && segments.deliverySeconds > 0
      ? actual * segments.mediaSeconds / segments.deliverySeconds : Infinity
    const drainRate = Math.max(0, 1 - Math.min(evidence.kbps, deliveryKbps) / actual, observedDrain)
    // A concurrent prefetch or retry can consume server bandwidth without
    // replenishing this track. Its shrinking lookahead takes precedence.
    // Segment lookahead also shrinks while deliberately waiting for PCM capacity.
    // Its observed drain predicts urgency, but only actual delivery measures capacity.
    const effectiveKbps = Math.min(evidence.kbps, deliveryKbps,
      !segments && observedDrain > 0 ? actual * Math.max(0, 1 - observedDrain) : Infinity)
    const candidate = this.best(effectiveKbps / (mode === 'automatic' ? 1.55 : 1.15), original, segments?.bitrates)
    const currentRank = this.rank(conditions.current)
    if (this.rank(candidate) >= currentRank) {
      state.stressedAt = null
      if (this.rank(candidate) > currentRank && this.canUpgrade(state, evidence, candidate, original)
        && (!segments || ahead >= Math.max(8, segments.overheadSeconds + 2 * segments.nextSeconds))) return candidate
      return null
    }
    const untilEmpty = drainRate > 0 ? ahead / drainRate : Infinity
    // Catching up a replacement from its beginning costs real bandwidth. Start
    // preparing before that cost consumes the remaining buffer.
    const preparation = segments
      ? segments.overheadSeconds + segments.nextSeconds * (candidate === 'original' ? original : candidate) / Math.max(evidence.kbps, 1)
      : conditions.position * (candidate === 'original' ? original : candidate) / Math.max(evidence.kbps, 1) + 4
    const threatened = untilEmpty < preparation + (mode === 'automatic' ? 15 : 7)
      || (conditions.position === 0 && ahead < 1 && evidence.kbps < actual)
    if (!threatened) { state.stressedAt = null; return null }
    state.stressedAt ??= now
    if (now - state.stressedAt < (mode === 'automatic' ? 3000 : 6000) || now - state.changedAt < 12_000) return null
    return candidate
  }

  committed(key: string, mode: AutomaticQualityMode, target: StreamQualityTarget, decisionKey = key): void {
    const state = this.state(decisionKey, mode)
    if (state.target !== target) state.changedAt = this.now()
    state.target = target
    state.stressedAt = null
    state.observation = undefined
  }

  failed(key: string, mode: AutomaticQualityMode): void {
    const state = this.state(key, mode)
    state.retryAt = this.now() + 30_000
    state.stressedAt = null
  }

  releaseDecision(key: string, mode: AutomaticQualityMode): void { this.decisions.delete(`${key}:${mode}`) }
}
