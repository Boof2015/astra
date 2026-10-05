import { createHash } from 'node:crypto'
import { getSubsonicPlaybackCapabilities, reportSubsonicScrobble, reportSubsonicTimeline,
  SubsonicRequestError, type SubsonicConnectionConfig } from './subsonic'
import { reportJellyfinPlayback, type JellyfinAuthContext, type JellyfinConnectionConfig } from './jellyfin'
import type { PlaybackReport, PlaybackReportClient } from './providerPlayback'

type Capabilities = Awaited<ReturnType<typeof getSubsonicPlaybackCapabilities>>
const capabilityCache = new Map<string, { capabilities: Capabilities; expiresAt: number }>()

export function createSubsonicPlaybackClient(config: SubsonicConnectionConfig, trackId: string,
  isCurrent: () => boolean = () => true): PlaybackReportClient {
  const key = createHash('sha256').update(JSON.stringify(config)).digest('hex')
  let beganTimeline = false
  const capabilities = async (signal: AbortSignal): Promise<Capabilities> => {
    const cached = capabilityCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.capabilities
    let result: Capabilities
    let lifetime = 600_000
    try { result = await getSubsonicPlaybackCapabilities(config, { signal, timeoutMs: 2500 }) }
    catch (error) {
      signal.throwIfAborted()
      const unsupported = error instanceof SubsonicRequestError
        && ([404, 405, 501].includes(error.httpStatus ?? 0) || error.apiCode === 70
          || (error.apiCode === 0 && /unknown|not found|unsupported|not supported|not implemented/i.test(error.message)))
      // A network/auth failure says nothing about capabilities. In particular,
      // don't accidentally enable server counting by falling back from timeline
      // reports with ignoreScrobble=true to a legacy now-playing request.
      if (!unsupported) throw error
      result = { timeline: false, navidrome: false }
      lifetime = 60_000
    }
    capabilityCache.delete(key)
    capabilityCache.set(key, { capabilities: result, expiresAt: Date.now() + lifetime })
    if (capabilityCache.size > 32) capabilityCache.delete(capabilityCache.keys().next().value!)
    return result
  }
  const live = async (report: PlaybackReport, signal: AbortSignal): Promise<void> => {
    if (!isCurrent()) return
    const caps = await capabilities(signal)
    signal.throwIfAborted()
    if (!isCurrent()) return
    if (caps.timeline) {
      if (!beganTimeline && report.state !== 'stopped') {
        await reportSubsonicTimeline(config, trackId, 'starting', report.position, { signal, timeoutMs: 4000 })
        beganTimeline = true
      }
      signal.throwIfAborted()
      if (!isCurrent()) return
      await reportSubsonicTimeline(config, trackId,
        report.state === 'loading' ? 'paused' : report.state, report.position, { signal, timeoutMs: 4000 })
    } else if (report.state === 'playing') {
      await reportSubsonicScrobble(config, trackId, { submission: false, startedAt: report.startedAt,
        ...(caps.navidrome ? { position: report.position } : {}) }, { signal, timeoutMs: 4000 })
    }
    // Legacy Subsonic has no pause/stop endpoint. Its now-playing entry expires.
  }
  return {
    start: live,
    progress: live, stop: live,
    scrobble: async (report, signal) => {
      if (isCurrent()) await reportSubsonicScrobble(config, trackId,
        { submission: true, startedAt: report.startedAt }, { signal, timeoutMs: 4000 })
    }
  }
}

export function createJellyfinPlaybackClient(config: JellyfinConnectionConfig, trackId: string,
  authenticate: (signal: AbortSignal, forceRefresh: boolean) => Promise<JellyfinAuthContext>,
  isCurrent: () => boolean = () => true): PlaybackReportClient {
  const send = async (event: 'start' | 'progress' | 'stop', report: PlaybackReport, signal: AbortSignal): Promise<void> => {
    if (!isCurrent()) return
    const payload = { trackId, sessionId: report.sessionId, position: report.position, paused: report.state !== 'playing' }
    const auth = await authenticate(signal, false)
    signal.throwIfAborted()
    if (!isCurrent()) return
    try { await reportJellyfinPlayback(config, auth, event, payload, { signal, timeoutMs: 4000 }) }
    catch (error) {
      // A rejected token is safe to refresh once. Ambiguous network failures are
      // not retried because a start may already have updated server play counts.
      if (!(error instanceof Error) || !error.message.endsWith('(401)')) throw error
      const refreshed = await authenticate(signal, true)
      signal.throwIfAborted()
      if (isCurrent()) await reportJellyfinPlayback(config, refreshed, event, payload, { signal, timeoutMs: 4000 })
    }
  }
  return { start: (r, s) => send('start', r, s), progress: (r, s) => send('progress', r, s), stop: (r, s) => send('stop', r, s) }
}
