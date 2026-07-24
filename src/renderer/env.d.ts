/// <reference types="vite/client" />

import { VisualizerDSP } from './audio/native/visualizer-dsp'
import type {
    MiniPlayerCommand,
    MiniPlayerSnapshot,
    MiniPlayerVisualizerMode,
    MiniPlayerVisualizerStreamChunk,
    MiniPlayerWindowState
} from '../types/miniPlayer'
import type {
    LyricsPopoutCommand,
    LyricsPopoutSnapshot,
    LyricsPopoutWindowState
} from '../types/lyricsPopout'
import type {
    ScopeKind,
    ScopePopoutChunk,
    ScopePopoutState
} from '../types/scopePopout'
import type {
  LocalApiStatus
} from '../types/localApi'
import type {
  CompanionApiRendererCommand,
  CompanionApiScope
} from '../types/companionApi'
import type {
  PhoneRemoteClientKind,
  PhoneRemotePairedDevice,
  PhoneRemotePairingTicket,
  PhoneRemotePendingPairingRequest,
  PhoneRemoteStatus
} from '../types/phoneRemote'
import type {
  ParallaxAudioChunk,
  ParallaxDiscoveryEvent,
  ParallaxHostStreamStartOptions,
  ParallaxHostNextStreamStartOptions,
  ParallaxHostTimelinePublishOptions,
  ParallaxOutputLatencyMetrics,
  ParallaxPairedSink,
  ParallaxSinkTelemetry,
  ParallaxStatus,
  ParallaxStreamInfo,
  ParallaxTimelineEvent,
  ParallaxTimelineState
} from '../types/parallax'
import type {
    LastFmAuthFinishResult,
    LastFmAuthStartResult,
    LastFmCustomProfileInput,
    LastFmStatus
} from '../types/lastFm'
import type {
    LyricsFormat,
    LyricsManualClearResult,
    LyricsManualImportResult,
    LyricsLookupResult,
    LyricsOffsetSetResult,
    LyricsStatus,
    LyricsTrackOverride,
    LyricsTrackQuery
} from '../types/lyrics'
import type {
    JellyfinSource,
    JellyfinSourceCreateInput,
    JellyfinSourceTestInput,
    JellyfinSourceTestResult,
    JellyfinSourceUpdateInput,
    JellyfinStatusSnapshot,
    SubsonicSource,
    SubsonicSourceCreateInput,
    SubsonicSourceTestInput,
    SubsonicSourceTestResult,
    SubsonicSourceUpdateInput,
    SubsonicStatusSnapshot,
    TrackSourceType
} from '../types/subsonic'
import type {
    AudioBufferMemoryStats,
    NativeAudioCapabilities,
    NativeAudioEvent,
    NativeAudioPlaybackSnapshot,
    NativeAudioTrackLoadResult,
    NativeAudioTrackMetadata,
    NativeAudioVisualizerTapDemand,
    NativeAudioVUMeterChunk,
    NativeAudioVectorscopeChunk
} from '../types/nativeAudio'
import type {
    ProgressiveAudioLoadProgress,
    ProgressiveStreamChunk,
    ProgressiveStreamEvent,
    ProgressiveStreamInfo,
    RemoteAudioLoadProgress,
    RemoteStreamChunk,
    RemoteStreamEvent,
    RemoteStreamInfo
} from '../types/remoteStream'
import type {
    MemoryDiagnosticsBlinkResourceUsageSnapshot,
    MemoryDiagnosticsCaptureBundleResult,
    MemoryDiagnosticsEventPayload,
    MemoryDiagnosticsProcessMemoryStats,
    MemoryDiagnosticsRendererSnapshot,
    MemoryDiagnosticsRendererMemoryStats,
    MemoryDiagnosticsSnapshotRequest,
    MemoryDiagnosticsStatus
} from '../types/diagnostics'
import type { AppBuildInfo } from '../types/appBuildInfo'
import type {
  GlobalShortcutRegistrationRequest,
  GlobalShortcutRegistrationResult,
  InputActionId,
  RawBindingInput
} from '../types/inputBindings'

type RuntimeIconImageSetPayload = {
    images: Array<{
        size: number
        dataUrl: string
    }>
}

interface DbTrack {
    id: number
    path: string
    album_identity_key: string
    is_new: boolean
    title: string
    artist: string
    artist_names: string[]
    album: string
    album_artist: string | null
    album_artist_names: string[]
    duration: number
    track_number: number | null
	    disc_number: number | null
	    year: number | null
	    genre: string | null
	    genres: string[]
	    artwork_hash: string | null
    base_artwork_hash: string | null
    format: string
    sample_rate: number | null
    bit_depth: number | null
    bitrate: number | null
    channels: number | null
    codec: string | null
    codec_profile: string | null
    is_atmos_joc: number | null
    is_iamf: number | null
    replaygain_track_gain_db: number | null
    replaygain_album_gain_db: number | null
    bpm: number | null
    musical_key: string | null
    source_type: TrackSourceType
    source_id: number | null
    source_track_id: string | null
    source_path: string | null
    is_available: number
    availability_reason: string | null
    file_created_at: number | null
    play_count: number
    last_played_at: number | null
    added_at: number
    modified_at: number
}

interface LibraryTrackPageRequest {
    offset?: number
    limit?: number
}

interface LibraryTrackPage {
    tracks: DbTrack[]
    offset: number
    limit: number
    total: number
    nextOffset: number
    hasMore: boolean
}

declare global {
    interface Window {
        // §22 Commit 1 — Parallax loopback (Windows-only WASAPI). See preload/index.ts for
        // shape; null when the native module didn't load or platform isn't supported.
        parallaxLoopbackAPI: {
            isSupported(): { supported: boolean; reason?: string }
            wallNowMs(): number
            start(): {
                ok: boolean
                endpoint?: {
                    deviceId: string
                    deviceName: string
                    sampleRate: number
                    channelCount: number
                    mixFormat: string
                    bitsPerSample: number
                }
                error?: string
            }
            stop(): void
            drain(): Array<{
                firstFrameIndex: number
                captureWallMs: number
                frameCount: number
                channelCount: number
                pcm: Float32Array
            }>
            isRunning(): boolean
        } | null
        visualizerAPI: VisualizerDSP | null
        visualizerAddonStatus: { available: boolean; reason: string | null }
        nativeAudioAPI: {
            initialize: () => Promise<NativeAudioCapabilities>
            getCapabilities: () => Promise<NativeAudioCapabilities>
            setOutputDevice: (deviceId: string) => Promise<NativeAudioCapabilities>
            loadTrack: (filePath: string, metadata?: NativeAudioTrackMetadata) => Promise<NativeAudioTrackLoadResult>
            preloadNextTrack: (filePath: string, metadata?: NativeAudioTrackMetadata) => Promise<NativeAudioTrackLoadResult>
            promoteNextTrack: (filePath: string, metadata?: NativeAudioTrackMetadata) => Promise<NativeAudioTrackLoadResult>
            play: () => Promise<NativeAudioPlaybackSnapshot>
            pause: () => Promise<NativeAudioPlaybackSnapshot>
            stop: () => Promise<NativeAudioPlaybackSnapshot>
            seek: (seconds: number) => Promise<NativeAudioPlaybackSnapshot>
            clearNextTrack: () => Promise<void>
            getPlaybackSnapshot: () => Promise<NativeAudioPlaybackSnapshot>
            getBufferMemoryStats: () => Promise<AudioBufferMemoryStats>
            setVisualizerTapDemand: (demand: NativeAudioVisualizerTapDemand) => Promise<void>
            flushOscilloscopeChunks: () => Float32Array[]
            flushSpectrumChunks: () => Float32Array[]
            flushVectorscopeChunks: () => NativeAudioVectorscopeChunk[]
            flushVUMeterChunks: () => NativeAudioVUMeterChunk[]
            onEvent: (callback: (event: NativeAudioEvent) => void) => () => void
        }
        electronAPI: {
            minimize: () => void
            maximize: () => void
            close: () => void
            isMaximized: () => Promise<boolean>
            associatedOpenFiles: {
                markReady: () => void
                onOpenFiles: (callback: (paths: string[]) => void) => () => void
            }
            miniPlayer: {
                open: () => Promise<void>
                close: () => Promise<void>
                getWindowState: () => Promise<MiniPlayerWindowState>
                isCursorInsideWindow: () => Promise<boolean>
                setVisualizerMode: (mode: MiniPlayerVisualizerMode) => Promise<MiniPlayerWindowState>
                toggleAlwaysOnTop: () => Promise<MiniPlayerWindowState>
                getSnapshot: () => Promise<MiniPlayerSnapshot | null>
                publishSnapshot: (snapshot: MiniPlayerSnapshot) => void
                publishQueueSnapshot: (snapshot: import('../types/miniPlayer').MiniPlayerQueueSnapshot) => void
                publishVisualizerChunk: (chunk: MiniPlayerVisualizerStreamChunk) => void
                sendCommand: (command: MiniPlayerCommand) => void
                onSnapshot: (callback: (snapshot: MiniPlayerSnapshot) => void) => () => void
                onCommand: (callback: (command: MiniPlayerCommand) => void) => () => void
                onWindowState: (callback: (state: MiniPlayerWindowState) => void) => () => void
                onVisualizerChunk: (callback: (chunk: MiniPlayerVisualizerStreamChunk) => void) => () => void
            }
            companionApi: {
                onCommand: (callback: (command: CompanionApiRendererCommand) => void) => () => void
            }
            lyricsPopout: {
                open: () => Promise<void>
                close: () => Promise<void>
                getWindowState: () => Promise<LyricsPopoutWindowState>
                getSnapshot: () => Promise<LyricsPopoutSnapshot | null>
                publishSnapshot: (snapshot: LyricsPopoutSnapshot) => void
                sendCommand: (command: LyricsPopoutCommand) => void
                onSnapshot: (callback: (snapshot: LyricsPopoutSnapshot) => void) => () => void
                onCommand: (callback: (command: LyricsPopoutCommand) => void) => () => void
                onWindowState: (callback: (state: LyricsPopoutWindowState) => void) => () => void
            }
            scopePopout: {
                open: (scope: ScopeKind) => Promise<ScopePopoutState>
                recall: (scope: ScopeKind) => Promise<ScopePopoutState>
                getState: () => Promise<ScopePopoutState>
                publishChunk: (chunk: ScopePopoutChunk) => void
                onState: (callback: (state: ScopePopoutState) => void) => () => void
                onChunk: (callback: (chunk: ScopePopoutChunk) => void) => () => void
            }
            platform: NodeJS.Platform
            getAppVersion: () => Promise<string>
            getAppBuildInfo: () => Promise<AppBuildInfo>
            getAppPerformanceStats: () => Promise<{ cpuPercent: number; workingSetMb: number; footprintMb: number | null; appProcessFootprintMb: number | null; childProcessFootprintMb: number | null; footprintSource: import('../shared/processMemoryFootprint').AppMemoryFootprintSource; footprintComplete: boolean; footprintFailedPids: number[]; footprintProcessCount: number; footprintAppProcessCount: number; footprintChildProcessCount: number; privateMemoryExcludingCallerMb: number | null; mainProcessMemoryMb: number | null; helperProcessesMemoryMb: number | null }>
            getMainProcessMemoryStats: () => Promise<MemoryDiagnosticsProcessMemoryStats>
            getRendererMemoryStats: () => Promise<MemoryDiagnosticsRendererMemoryStats>
            diagnostics: {
                getStatus: () => Promise<MemoryDiagnosticsStatus>
                setEnabled: (enabled: boolean) => Promise<MemoryDiagnosticsStatus>
                revealCurrentLog: () => Promise<boolean>
                revealPreviousLog: () => Promise<boolean>
                captureMemoryBundle: (tag?: string) => Promise<MemoryDiagnosticsCaptureBundleResult>
                getBlinkResourceUsage: () => MemoryDiagnosticsBlinkResourceUsageSnapshot
                clearRendererCache: () => void
                publishRendererSnapshot: (requestId: string, snapshot: MemoryDiagnosticsRendererSnapshot) => void
                logEvent: (payload: MemoryDiagnosticsEventPayload) => Promise<boolean>
                onStatus: (callback: (status: MemoryDiagnosticsStatus) => void) => () => void
                onSnapshotRequest: (callback: (request: MemoryDiagnosticsSnapshotRequest) => void) => () => void
            }
            updates: {
                checkForUpdates: () => Promise<{
                    status: 'up-to-date' | 'update-available' | 'error'
                    updateAvailable: boolean
                    currentVersion: string
                    latestTag: string | null
                    latestVersion: string | null
                    releaseName: string | null
                    releaseUrl: string
                    checkedAt: number
                    message: string
                }>
                openReleasesPage: (releaseUrl?: string) => Promise<boolean>
            }
            theme: {
                setRuntimeIconDataUrl: (payload: string | RuntimeIconImageSetPayload) => void
            }
            inputBindings: {
                configureGlobal: (requests: GlobalShortcutRegistrationRequest[]) => Promise<GlobalShortcutRegistrationResult[]>
                onInput: (callback: (input: RawBindingInput) => void) => () => void
                onGlobalAction: (callback: (actionId: InputActionId) => void) => () => void
            }
            discord: {
                configure: (options: { enabled: boolean; coverArtEnabled: boolean; smallIconEnabled?: boolean; compactStatusMode?: 'title' | 'artist'; expandedInfoMode?: 'file-info' | 'album'; linkDestination?: 'off' | 'ytmusic' | 'lastfm'; pauseClearMinutes?: number }) => Promise<{ ok: boolean; connected: boolean; message: string }>
                updatePresence: (update: {
                    playbackState: 'stopped' | 'playing' | 'paused' | 'loading'
                    currentTimeSeconds?: number
                    durationSeconds?: number
                    track?: {
                        title: string
                        artist?: string
                        album?: string
                        albumArtist?: string
                        coverArtUrl?: string
                        durationSeconds?: number
                        format?: string
                        sampleRate?: number
                        bitDepth?: number
                        bitrate?: number
                        channels?: number
                        codec?: string
                        codecProfile?: string
                        isAtmosJoc?: boolean
                    } | null
                }) => void
                clearPresence: () => void
                resolveCoverArt: (query: { album: string; artist?: string; albumArtist?: string; title?: string }) => Promise<
                    | { status: 'hit'; url: string }
                    | { status: 'not_found' }
                    | { status: 'transient_error'; code?: string }
                >
            }
            localApi: {
                getStatus: () => Promise<LocalApiStatus>
                setEnabled: (enabled: boolean) => Promise<LocalApiStatus>
                setControlsEnabled: (enabled: boolean) => Promise<LocalApiStatus>
                setLibrarySearchEnabled: (enabled: boolean) => Promise<LocalApiStatus>
                setLibraryWriteEnabled: (enabled: boolean) => Promise<LocalApiStatus>
                setPort: (port: number) => Promise<LocalApiStatus>
                rotateToken: () => Promise<LocalApiStatus>
                resetToDefaults: () => Promise<LocalApiStatus>
                onStatus: (callback: (status: LocalApiStatus) => void) => () => void
            }
            phoneRemote: {
                getStatus: () => Promise<PhoneRemoteStatus>
                createPairingTicket: (baseUrl?: string, clientKind?: PhoneRemoteClientKind) => Promise<PhoneRemotePairingTicket>
                listPairedDevices: () => Promise<PhoneRemotePairedDevice[]>
                listPendingPairingRequests: () => Promise<PhoneRemotePendingPairingRequest[]>
                approvePairingRequest: (id: string, grantedScopes?: CompanionApiScope[]) => Promise<PhoneRemotePendingPairingRequest | null>
                rejectPairingRequest: (id: string) => Promise<PhoneRemotePendingPairingRequest | null>
                revokePairedDevice: (id: string) => Promise<PhoneRemotePairedDevice | null>
                revokeAllPairedDevices: () => Promise<number>
                setEnabled: (enabled: boolean) => Promise<PhoneRemoteStatus>
                setPort: (port: number) => Promise<PhoneRemoteStatus>
                resetToDefaults: () => Promise<PhoneRemoteStatus>
                onStatus: (callback: (status: PhoneRemoteStatus) => void) => () => void
            }
            parallax: {
                useHostPredictor: boolean
                launchInZoneMode: boolean
                getStatus: () => Promise<ParallaxStatus>
                getEndpointIdentity: () => Promise<{ hostname: string; lanIps: string[] }>
                fetchSinkArtwork: (streamId: string) => Promise<string | null>
                requestSinkTrimUpdate: (
                    outputDeviceId: string,
                    outputDeviceLabel: string | null,
                    advanceMs: number
                ) => Promise<boolean>
                listPairedSinks: () => Promise<ParallaxPairedSink[]>
                setHostEnabled: (enabled: boolean) => Promise<ParallaxStatus>
                setSinkEnabled: (enabled: boolean) => Promise<ParallaxStatus>
                startDiscoveryBrowse: () => Promise<{ ok: true }>
                stopDiscoveryBrowse: () => Promise<{ ok: true }>
                onDiscoveryEvent: (callback: (event: ParallaxDiscoveryEvent) => void) => () => void
                initiatePair: (sinkBaseUrl: string) => Promise<{
                    pairingId: string
                    sinkParallaxEndpointUuid: string | null
                    sinkName: string
                    expiresInSeconds: number
                }>
                submitPairPin: (
                    pairingId: string,
                    pin: string,
                    sinkName?: string
                ) => Promise<{ sinkId: string; sinkName: string; sinkParallaxEndpointUuid: string | null }>
                cancelPair: (pairingId: string) => Promise<{ ok: boolean }>
                cancelIncomingPair: () => Promise<{ ok: true }>
                approveIncomingPair: () => Promise<{ ok: boolean }>
                setHostPort: (port: number) => Promise<ParallaxStatus>
                disconnectSink: () => Promise<ParallaxStatus>
                publishHostStreamStart: (
                    info: Omit<ParallaxStreamInfo, 'chunkFrames' | 'groupLatencyMs' | 'createdAt'>,
                    options?: ParallaxHostStreamStartOptions
                ) => Promise<ParallaxTimelineState>
                publishHostNextStreamStart: (
                    info: Omit<ParallaxStreamInfo, 'chunkFrames' | 'groupLatencyMs' | 'createdAt'>,
                    options: ParallaxHostNextStreamStartOptions
                ) => Promise<ParallaxTimelineState>
                publishHostNextStreamCancel: () => Promise<void>
                publishHostPromoteNextStream: () => Promise<ParallaxTimelineState | null>
                publishHostAudioChunk: (chunk: ParallaxAudioChunk) => Promise<void>
                publishHostTimeline: (timeline: ParallaxTimelineState, options?: ParallaxHostTimelinePublishOptions) => Promise<void>
                publishHostEmitAnchor: (anchor: Omit<Extract<ParallaxTimelineEvent, { type: 'host-emit-anchor' }>, 'emittedAtHostTimeMs'>) => Promise<void>
                stopHostStream: () => Promise<void>
                publishSinkTelemetry: (telemetry: ParallaxSinkTelemetry) => Promise<void>
                reportHostLatency: (metrics: ParallaxOutputLatencyMetrics) => Promise<void>
                revokePairedSink: (id: string) => Promise<ParallaxPairedSink | null>
                renamePairedSink: (id: string, name: string) => Promise<ParallaxPairedSink | null>
                setSinkPlaybackEnabled: (id: string, enabled: boolean) => Promise<ParallaxStatus>
                setAllSinksPlaybackEnabled: (enabled: boolean) => Promise<ParallaxStatus>
                revokeAllPairedSinks: () => Promise<number>
                clearHostPresenceCache: (sinkId?: string) => Promise<ParallaxStatus>
                resetToDefaults: () => Promise<ParallaxStatus>
                setSinkTrim: (
                    sinkId: string,
                    outputDeviceId: string,
                    outputDeviceLabel: string | null,
                    advanceMs: number
                ) => Promise<ParallaxStatus>
                forgetSinkConnection: () => Promise<ParallaxStatus>
                reconnectFromPersisted: () => Promise<ParallaxStatus>
                startAutoReconnect: () => Promise<{ scheduled: boolean; reason?: 'no-persisted-connection' | 'host-mode-active' }>
                onSinkPaired: (callback: () => void) => () => void
                onStatus: (callback: (status: ParallaxStatus) => void) => () => void
                onEvent: (callback: (event: ParallaxTimelineEvent) => void) => () => void
                onAudioChunk: (callback: (chunk: ParallaxAudioChunk) => void) => () => void
            }
            lastFm: {
                getStatus: () => Promise<LastFmStatus>
                setEnabled: (enabled: boolean) => Promise<LastFmStatus>
                createCustomProfile: (input: LastFmCustomProfileInput) => Promise<LastFmStatus>
                updateCustomProfile: (profileId: string, input: LastFmCustomProfileInput) => Promise<LastFmStatus>
                deleteCustomProfile: (profileId: string) => Promise<LastFmStatus>
                setActiveProfile: (profileId: string) => Promise<LastFmStatus>
                setProfileEnabled: (profileId: string, enabled: boolean) => Promise<LastFmStatus>
                beginAuth: (profileId?: string) => Promise<LastFmAuthStartResult>
                finishAuth: () => Promise<LastFmAuthFinishResult>
                disconnect: () => Promise<LastFmStatus>
                disconnectProfile: (profileId: string) => Promise<LastFmStatus>
                resetToDefaults: () => Promise<LastFmStatus>
                onStatus: (callback: (status: LastFmStatus) => void) => () => void
            }
            lyrics: {
                getStatus: () => Promise<LyricsStatus>
                setEnabled: (enabled: boolean) => Promise<LyricsStatus>
                setLrclibBaseUrl: (baseUrl: string) => Promise<LyricsStatus>
                getForTrack: (query: LyricsTrackQuery) => Promise<LyricsLookupResult>
                refreshForTrack: (query: LyricsTrackQuery) => Promise<LyricsLookupResult>
                getTrackOverride: (trackPath: string) => Promise<LyricsTrackOverride>
                importManualLyrics: (trackPaths: string[], lyricsText: string, format?: LyricsFormat) => Promise<LyricsManualImportResult>
                clearManualLyrics: (trackPaths: string[]) => Promise<LyricsManualClearResult>
                setTrackOffset: (trackPaths: string[], offsetMs: number) => Promise<LyricsOffsetSetResult>
                resetToDefaults: () => Promise<LyricsStatus>
                onStatus: (callback: (status: LyricsStatus) => void) => () => void
            }
            subsonic: {
                listSources: () => Promise<SubsonicSource[]>
                createSource: (input: SubsonicSourceCreateInput) => Promise<SubsonicSource>
                updateSource: (sourceId: number, input: SubsonicSourceUpdateInput) => Promise<SubsonicSource>
                deleteSource: (sourceId: number, purgeTracks: boolean) => Promise<void>
                testSource: (input: SubsonicSourceTestInput) => Promise<SubsonicSourceTestResult>
                syncSource: (sourceId: number) => Promise<void>
                syncAll: () => Promise<void>
                getStatus: () => Promise<SubsonicStatusSnapshot>
                onStatus: (callback: (status: SubsonicStatusSnapshot) => void) => () => void
            }
            jellyfin: {
                listSources: () => Promise<JellyfinSource[]>
                createSource: (input: JellyfinSourceCreateInput) => Promise<JellyfinSource>
                updateSource: (sourceId: number, input: JellyfinSourceUpdateInput) => Promise<JellyfinSource>
                deleteSource: (sourceId: number, purgeTracks: boolean) => Promise<void>
                testSource: (input: JellyfinSourceTestInput) => Promise<JellyfinSourceTestResult>
                syncSource: (sourceId: number) => Promise<void>
                syncAll: () => Promise<void>
                getStatus: () => Promise<JellyfinStatusSnapshot>
                onStatus: (callback: (status: JellyfinStatusSnapshot) => void) => () => void
            }
            openAudioFile: () => Promise<{
                path: string
                name: string
                data?: ArrayBuffer
                metadata?: {
                    title?: string
                    artist?: string
                    artistNames?: string[]
                    album?: string
                    albumArtist?: string
                    albumArtistNames?: string[]
                    year?: number
                    trackNumber?: number
                    duration?: number
                    format?: string
                    sampleRate?: number
                    channels?: number
                    codec?: string
                    codecProfile?: string
                    isAtmosJoc?: boolean
                    replayGainTrackDb?: number
                    replayGainAlbumDb?: number
                    artworkHash?: string
                    artwork?: string
                }
            } | null>
            openAudioFolder: () => Promise<string | null>
            getSpatialWasmBytes: () => Promise<ArrayBuffer>
            getIamfWasmBytes: () => Promise<ArrayBuffer>
            loadAudioFile: (
                filePath: string,
                options?: { metadataMode?: 'full' | 'none' }
            ) => Promise<{
                path: string
                name: string
                data: ArrayBuffer
                metadata?: {
                    title?: string
                    artist?: string
                    artistNames?: string[]
                    album?: string
                    albumArtist?: string
                    albumArtistNames?: string[]
                    year?: number
                    trackNumber?: number
                    duration?: number
                    format?: string
                    sampleRate?: number
                    channels?: number
                    codec?: string
                    codecProfile?: string
                    isAtmosJoc?: boolean
                    replayGainTrackDb?: number
                    replayGainAlbumDb?: number
                    artworkHash?: string
                    artwork?: string
                }
            } | null>
            getAudioMetadata: (filePath: string) => Promise<{
                title?: string
                artist?: string
                artistNames?: string[]
                album?: string
                albumArtist?: string
                albumArtistNames?: string[]
                year?: number
                trackNumber?: number
                duration?: number
                format?: string
                sampleRate?: number
                channels?: number
                codec?: string
                codecProfile?: string
                isAtmosJoc?: boolean
                replayGainTrackDb?: number
                replayGainAlbumDb?: number
                artworkHash?: string
                artwork?: string
            } | null>
            getAudioFileStat: (filePath: string) => Promise<{
                size: number
                mtimeMs: number
            } | null>
            decodeAudioWithFfmpeg: (filePath: string) => Promise<ArrayBuffer | null>
            analyzeTrackLoudness: (filePath: string) => Promise<{
                loudnessLufs: number
                peakLinear: number | null
                method: string
            } | null>
            warmupTrackLoudness: (filePath: string) => Promise<{
                loudnessLufs: number
                peakLinear: number | null
                method: string
            } | null>
            storeTrackLoudness: (
                filePath: string,
                payload: { loudnessLufs: number; peakLinear?: number | null; method?: string }
            ) => Promise<boolean>
            startProgressiveStream: (
                filePath: string,
                outputSampleRate: number,
                expectedChannels?: number | null,
                options?: { startTimeSeconds?: number | null }
            ) => Promise<ProgressiveStreamInfo>
            cancelProgressiveStream: (sessionId: number) => Promise<void>
            startRemoteStream: (
                filePath: string,
                outputSampleRate: number,
                expectedChannels?: number | null
            ) => Promise<RemoteStreamInfo>
            cancelRemoteStream: (sessionId: number) => Promise<void>
            getReplayGainScanEnabled: () => Promise<boolean>
            setReplayGainScanEnabled: (enabled: boolean) => Promise<boolean>
            onRemoteLoadProgress: (callback: (progress: RemoteAudioLoadProgress) => void) => () => void
            onProgressiveLoadProgress: (callback: (progress: ProgressiveAudioLoadProgress) => void) => () => void
            onRemoteStreamChunk: (callback: (chunk: RemoteStreamChunk) => void) => () => void
            onProgressiveStreamChunk: (callback: (chunk: ProgressiveStreamChunk) => void) => () => void
            onRemoteStreamEvent: (callback: (payload: RemoteStreamEvent) => void) => () => void
            onProgressiveStreamEvent: (callback: (payload: ProgressiveStreamEvent) => void) => () => void
            showSaveDialog: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>
            openFileDialog: (options: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>
            readTextFile: (filePath: string) => Promise<string>
            readFileAsDataUrl: (filePath: string) => Promise<string | null>
            writeSettingsTransferFile: (filePath: string, content: string) => Promise<boolean>
            writeFile: (filePath: string, content: string) => Promise<boolean>
            revealFileInFolder: (filePath: string) => Promise<boolean>
            statsShare: {
                copyPng: (bytes: Uint8Array) => Promise<boolean>
                savePng: (bytes: Uint8Array, suggestedFileName: string) => Promise<string | null>
            }
            signalShare: {
                copyPng: (bytes: Uint8Array) => Promise<boolean>
                savePng: (bytes: Uint8Array, suggestedFileName: string) => Promise<string | null>
            }
            library: {
                getTracks: () => Promise<DbTrack[]>
                getTracksPage: (request?: LibraryTrackPageRequest) => Promise<LibraryTrackPage>
                getTracksByPaths: (trackPaths: string[]) => Promise<DbTrack[]>
                [key: string]: any
            }
        }
    }
}
