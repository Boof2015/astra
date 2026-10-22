// Silent integration harness: execute Astra's actual main-process functions with
// a fake Electron sender/library. Network, FFmpeg and PCM delivery remain real.
import assert from 'node:assert/strict'
import { buildSubsonicTrackPath, parseSubsonicTrackPath } from '../../src/main/services/subsonic.ts'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import ts from 'typescript'
import { ProgressiveStartupRegistry } from '../../src/main/progressiveStartupRegistry.ts'
import { ProgressivePcmDelivery } from '../../src/main/progressivePcmDelivery.ts'
import { resolveLocalProgressiveBackpressureAction, REMOTE_PROGRESSIVE_PCM_MAX_BYTES } from '../../src/main/progressiveStreamBackpressure.ts'
import { withRemoteCompatibility, RemoteCompatibilityFailure, isUnsupportedRemoteDecoder } from '../../src/shared/audio/remoteCompatibility.ts'
import { StratumProofPcm } from '../../src/main/services/stratumProofPlayback.ts'
import { StratumPrefetchGate, canPrefetchStratum } from '../../src/main/services/stratumPrefetch.ts'
import { PlaybackNetworkPriority } from '../../src/main/services/playbackNetworkPriority.ts'
import { CompletedStreamingDiagnostics } from '../../src/main/services/streamingDiagnostics.ts'
import { stratumPlaybackQuality } from '../../src/main/services/stratumQuality.ts'
import { AutomaticStreamingQuality } from '../../src/main/services/automaticStreamingQuality.ts'
import { parseStratumProofConfig, stratumProofRoute, stratumQualitySelection, type StratumProofConfig } from '../../src/main/services/stratumProofConfig.ts'
import type { StratumAudioCache } from '../../src/main/services/stratumAudioCache.ts'
import type { StratumConnections } from '../../src/main/services/stratumConnections.ts'
import { resolveStreamingQuality } from '../../src/types/streamingQuality.ts'
import type { RemoteStreamInfo, RemoteStreamChunk, RemoteStreamEvent } from '../../src/types/remoteStream.ts'
import type { StreamingQualityRequest } from '../../src/types/streamingQuality.ts'
import type { StratumProofQuality } from '../../src/main/services/stratumProofClient.ts'
import type { RemoteAudioLease } from '../../src/main/services/remoteAudioCache.ts'

const names = ['startProgressiveStreamSession', 'startProgressiveStreamAttempt', 'finalizeRemoteStreamSession',
  'settleRemoteStreamStartup', 'pumpRemoteStreamOutput', 'flushRemoteStreamOutput', 'emitRemoteStreamChunk',
  'cancelProgressiveStreamSession', 'isRemoteStreamPipeTeardownError', 'updateLocalProgressiveStreamBackpressure',
  'resolveProgressiveStreamSourceType', 'normalizeProgressiveStartTimeSeconds', 'safeSendRemoteStreamEvent', 'streamingDiagnosticsSnapshot', 'installedStratumRoute',
  'buildRemoteLoadProgress', 'safeSendRemoteLoadProgress', 'stratumPrefetchAllowed', 'holdArtworkForPlayback']
const source = ts.createSourceFile('index.ts', readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const declarations = source.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? ''))
assert.equal(declarations.length, names.length)
const javascript = ts.transpileModule(declarations.map(node => node.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText

export function mainHarness(config: StratumProofConfig, ffmpeg: string,
  options: { deliver?: (channel: string, value: unknown) => void; recordPcm?: boolean;
    segmentQuality?: (seconds: number) => StratumProofQuality; policy?: AutomaticStreamingQuality;
    duration?: (path: string) => number;
    installed?: StratumConnections; cache?: StratumAudioCache; priority?: PlaybackNetworkPriority;
    acquire?: (path: string, signal: AbortSignal, quality?: StreamingQualityRequest) => Promise<RemoteAudioLease> } = {}) {
  const chunks: RemoteStreamChunk[] = [], events: RemoteStreamEvent[] = []
  const sessions = new Map<number, any>()
  const registry = new ProgressiveStartupRegistry()
  const qualityEvents: Array<{ seconds: number; quality: StratumProofQuality }> = []
  const completedStreamingDiagnostics = new CompletedStreamingDiagnostics()
  const stratumPrefetchGate = new StratumPrefetchGate()
  // Listening-only schedule injection at the adapter's existing quality callback.
  // Application preferences/automatic decisions are not modified by this fixture.
  const proofPcm = options.segmentQuality ? {
    open: async (...args: Parameters<typeof StratumProofPcm.open>) => {
      const pcm = await StratumProofPcm.open(...args)
      const feed = pcm.feed.bind(pcm)
      pcm.feed = (input, binary, signal, _quality, onBytes) => feed(input, binary, signal, start => {
        const seconds = start / pcm.playback.source.sample_rate
        const quality = options.segmentQuality!(seconds)
        qualityEvents.push({ seconds, quality })
        return quality
      }, onBytes)
      return pcm
    }
  } : StratumProofPcm
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false,
    send: (channel: string, value: any) => {
      if (channel === 'audio:progressiveStreamChunk' && options.recordPcm !== false) chunks.push(value)
      if (channel === 'audio:progressiveStreamEvent') events.push(value)
      options.deliver?.(channel, value)
    } })
  const context = {
    Buffer, AbortController, setInterval, clearInterval, spawn, ProgressivePcmDelivery, StratumProofPcm: proofPcm,
    stratumPlaybackQuality, automaticStreamingQuality: options.policy ?? new AutomaticStreamingQuality(),
    parseStratumProofConfig, stratumProofRoute, stratumQualitySelection, resolveStreamingQuality,
    stratumConnections: options.installed, getStratumAudioCache: () => options.cache, streamingQualityPreferences: { read: () => ({ global: 'original', overrides: {} }) },
    withRemoteCompatibility, RemoteCompatibilityFailure, isUnsupportedRemoteDecoder,
    remoteStreamSessions: sessions, completedStreamingDiagnostics, stratumPrefetchGate, canPrefetchStratum,
    playbackNetworkPriority: options.priority ?? new PlaybackNetworkPriority(), progressiveStartupControllers: registry, resolveLocalProgressiveBackpressureAction,
    isDev: !options.installed, app: { isPackaged: false }, process: { env: { ASTRA_STRATUM_PROOF_CONFIG: 'fixture' } },
    readFileSync: () => JSON.stringify({ experiment: 'astra-stratum-standard-proof-1', ...config }),
    library: { getTrackByPath: () => ({ channels: 2, format: 'wav', sample_rate: 48000, bit_depth: 16 }), getSubsonicSourceById: () => ({ enabled: 1 }) },
    parseSubsonicTrackPath,
    isSubsonicPath: (path: string) => path.startsWith('subsonic://'),
    isJellyfinPath: (path: string) => path.startsWith('jellyfin://'), isPlexPath: (path: string) => path.startsWith('plex://'),
    resolveBinary: async () => ffmpeg,
    resolveRemoteTrackDurationSeconds: options.duration ?? (() => { throw new Error('Catalog duration used instead of authenticated source.') }),
    SUBSONIC_DOWNLOAD_PROGRESS_EMIT_INTERVAL_MS: 80, REMOTE_STREAM_PLAYABLE_SECONDS: .75,
    toStandaloneArrayBuffer: (data: Buffer) => new Uint8Array(data).buffer,
    REMOTE_STREAM_CHUNK_FRAMES: 4096, LOCAL_STREAM_STARTUP_CHUNK_FRAMES: 8192,
    LOCAL_STREAM_STEADY_AFTER_SECONDS: 1, LOCAL_STREAM_STEADY_CHUNK_FRAMES: 65536, REMOTE_PROGRESSIVE_PCM_MAX_BYTES,
    acquireCachedRemoteAudio: options.acquire ?? (() => { throw new Error('Unexpected conventional cache fallback.') })
  }
  const api = new Function(...Object.keys(context), `let nextRemoteStreamSessionId = 1;\n${javascript}\nreturn { start: startProgressiveStreamSession, cancel: cancelProgressiveStreamSession, update: updateLocalProgressiveStreamBackpressure, finalize: finalizeRemoteStreamSession, diagnostics: streamingDiagnosticsSnapshot }`)(...Object.values(context))
  return { sessions, events, chunks, sender, registry, qualityEvents,
    diagnostics: (id: number) => sessions.has(id) ? api.diagnostics(sessions.get(id)) : completedStreamingDiagnostics.get(sender, id),
    startOptions: (path: string, rate: number, channels: number | null, startOptions: Record<string, unknown>): Promise<RemoteStreamInfo> =>
      api.start(sender, path, rate, channels, startOptions),
    start: (track: string, rate: number, quality: StreamingQualityRequest = 'original', seconds = 0, slot = 'current'): Promise<RemoteStreamInfo> =>
      api.start(sender, buildSubsonicTrackPath(config.sourceId, track), rate, 2, { streamingQuality: quality, startTimeSeconds: seconds, slot }),
    ready: (id: number, consume = true) => {
      const session = sessions.get(id)
      if (!session) return
      session.rendererReady = true
      if (consume) session.consumedFrames = session.decodedFrames
      api.update(session)
      if (session.pendingOutcome && session.pcmDelivery?.drained) {
        const pending = session.pendingOutcome; session.pendingOutcome = null
        api.finalize(session, pending.outcome, pending.error)
      }
    },
    position: (id: number, frame: number) => {
      const session = sessions.get(id)
      if (!session) return
      session.rendererReady = true
      session.consumedFrames = Math.max(session.consumedFrames,
        Number.isFinite(frame) ? Math.max(0, Math.min(session.decodedFrames, Math.floor(frame))) : 0)
      if (session.stratum) stratumPrefetchGate.changed()
      api.update(session)
      if (session.pendingOutcome && session.pcmDelivery?.drained) {
        const pending = session.pendingOutcome; session.pendingOutcome = null
        api.finalize(session, pending.outcome, pending.error)
      }
    },
    // Mirrors audio:activateProgressiveStream after a renderer gapless handoff.
    activate: (id: number) => {
      const session = sessions.get(id)
      if (!session) return
      session.slot = 'current'
      if (session.stratum) stratumPrefetchGate.changed()
    },
    cancel: (id: number): Promise<void> => api.cancel(id),
    close: async () => { registry.cancelAll(); for (const id of sessions.keys()) await api.cancel(id) }
  }
}
