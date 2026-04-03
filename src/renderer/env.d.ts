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
    ScopeKind,
    ScopePopoutChunk,
    ScopePopoutState
} from '../types/scopePopout'
import type { LocalApiStatus } from '../types/localApi'
import type {
    LastFmAuthFinishResult,
    LastFmAuthStartResult,
    LastFmStatus
} from '../types/lastFm'
import type {
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
    SubsonicStatusSnapshot
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
    MemoryDiagnosticsEventPayload,
    MemoryDiagnosticsRendererSnapshot,
    MemoryDiagnosticsSnapshotRequest,
    MemoryDiagnosticsStatus
} from '../types/diagnostics'

declare global {
    interface Window {
        visualizerAPI: VisualizerDSP | null
        nativeAudioAPI: {
            initialize: () => Promise<NativeAudioCapabilities>
            getCapabilities: () => Promise<NativeAudioCapabilities>
            setOutputDevice: (deviceId: string) => Promise<NativeAudioCapabilities>
            loadTrack: (filePath: string, metadata?: NativeAudioTrackMetadata) => Promise<NativeAudioTrackLoadResult>
            preloadNextTrack: (filePath: string, metadata?: NativeAudioTrackMetadata) => Promise<NativeAudioTrackLoadResult>
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
                setVisualizerMode: (mode: MiniPlayerVisualizerMode) => Promise<MiniPlayerWindowState>
                toggleAlwaysOnTop: () => Promise<MiniPlayerWindowState>
                getSnapshot: () => Promise<MiniPlayerSnapshot | null>
                publishSnapshot: (snapshot: MiniPlayerSnapshot) => void
                publishVisualizerChunk: (chunk: MiniPlayerVisualizerStreamChunk) => void
                sendCommand: (command: MiniPlayerCommand) => void
                onSnapshot: (callback: (snapshot: MiniPlayerSnapshot) => void) => () => void
                onCommand: (callback: (command: MiniPlayerCommand) => void) => () => void
                onWindowState: (callback: (state: MiniPlayerWindowState) => void) => () => void
                onVisualizerChunk: (callback: (chunk: MiniPlayerVisualizerStreamChunk) => void) => () => void
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
            getAppPerformanceStats: () => Promise<{ cpuPercent: number; workingSetMb: number }>
            getRendererMemoryStats: () => Promise<{
                privateMb: number
                rssBytes: number
                heapUsedBytes: number
                heapTotalBytes: number
                externalBytes: number
                arrayBuffersBytes: number
                heapSpaces: {
                    oldSpaceUsedBytes: number | null
                    newSpaceUsedBytes: number | null
                    codeSpaceUsedBytes: number | null
                    mapSpaceUsedBytes: number | null
                    largeObjectSpaceUsedBytes: number | null
                }
            }>
            diagnostics: {
                getStatus: () => Promise<MemoryDiagnosticsStatus>
                setEnabled: (enabled: boolean) => Promise<MemoryDiagnosticsStatus>
                revealCurrentLog: () => Promise<boolean>
                revealPreviousLog: () => Promise<boolean>
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
                setRuntimeIconDataUrl: (dataUrl: string) => void
            }
            discord: {
                configure: (options: { enabled: boolean; coverArtEnabled: boolean }) => Promise<{ ok: boolean; connected: boolean; message: string }>
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
                setPort: (port: number) => Promise<LocalApiStatus>
                rotateToken: () => Promise<LocalApiStatus>
                resetToDefaults: () => Promise<LocalApiStatus>
                onStatus: (callback: (status: LocalApiStatus) => void) => () => void
            }
            lastFm: {
                getStatus: () => Promise<LastFmStatus>
                setEnabled: (enabled: boolean) => Promise<LastFmStatus>
                beginAuth: () => Promise<LastFmAuthStartResult>
                finishAuth: () => Promise<LastFmAuthFinishResult>
                disconnect: () => Promise<LastFmStatus>
                resetToDefaults: () => Promise<LastFmStatus>
                onStatus: (callback: (status: LastFmStatus) => void) => () => void
            }
            lyrics: {
                getStatus: () => Promise<LyricsStatus>
                setEnabled: (enabled: boolean) => Promise<LyricsStatus>
                getForTrack: (query: LyricsTrackQuery) => Promise<LyricsLookupResult>
                refreshForTrack: (query: LyricsTrackQuery) => Promise<LyricsLookupResult>
                getTrackOverride: (trackPath: string) => Promise<LyricsTrackOverride>
                importManualLyrics: (trackPaths: string[], lyricsText: string) => Promise<LyricsManualImportResult>
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
                data: ArrayBuffer
                metadata?: {
                    title?: string
                    artist?: string
                    album?: string
                    albumArtist?: string
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
                    artwork?: string
                }
            } | null>
            openAudioFolder: () => Promise<string | null>
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
                    album?: string
                    albumArtist?: string
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
                    artwork?: string
                }
            } | null>
            getAudioMetadata: (filePath: string) => Promise<{
                title?: string
                artist?: string
                album?: string
                albumArtist?: string
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
                artwork?: string
            } | null>
            decodeAudioWithFfmpeg: (filePath: string) => Promise<ArrayBuffer | null>
            startRemoteStream: (
                filePath: string,
                outputSampleRate: number,
                expectedChannels?: number | null
            ) => Promise<{
                sessionId: number
                path: string
                sourceType: 'subsonic' | 'jellyfin'
                sampleRate: number
                channels: number
                durationSeconds: number | null
                initialChunk?: {
                    sessionId: number
                    path: string
                    sourceType: 'subsonic' | 'jellyfin'
                    sampleRate: number
                    channels: number
                    frameCount: number
                    pcmData: ArrayBuffer
                    decodedFrames: number
                    decodedSeconds: number
                } | null
            }>
            cancelRemoteStream: (sessionId: number) => Promise<void>
            getReplayGainScanEnabled: () => Promise<boolean>
            setReplayGainScanEnabled: (enabled: boolean) => Promise<boolean>
            onRemoteLoadProgress: (callback: (progress: {
                path: string
                sourceType: 'subsonic' | 'jellyfin'
                stage: 'downloading' | 'streaming' | 'complete' | 'failed'
                loadedBytes: number
                totalBytes: number | null
                chunkCount: number
                percent: number | null
                done: boolean
                failed: boolean
                bufferedSeconds: number
                bufferedPercent: number | null
                analyzedSeconds: number
                analyzedPercent: number | null
                playable: boolean
            }) => void) => () => void
            onRemoteStreamChunk: (callback: (chunk: {
                sessionId: number
                path: string
                sourceType: 'subsonic' | 'jellyfin'
                sampleRate: number
                channels: number
                frameCount: number
                pcmData: ArrayBuffer
                decodedFrames: number
                decodedSeconds: number
            }) => void) => () => void
            onRemoteStreamEvent: (callback: (payload:
                | {
                    sessionId: number
                    path: string
                    sourceType: 'subsonic' | 'jellyfin'
                    type: 'started'
                    sampleRate: number
                    channels: number
                    durationSeconds: number | null
                }
                | {
                    sessionId: number
                    path: string
                    sourceType: 'subsonic' | 'jellyfin'
                    type: 'complete' | 'cancelled'
                    decodedFrames: number
                    decodedSeconds: number
                }
                | {
                    sessionId: number
                    path: string
                    sourceType: 'subsonic' | 'jellyfin'
                    type: 'failed'
                    message: string
                    decodedFrames: number
                    decodedSeconds: number
                }
            ) => void) => () => void
            showSaveDialog: (options: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>
            openFileDialog: (options: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>
            readTextFile: (filePath: string) => Promise<string>
            readFileAsDataUrl: (filePath: string) => Promise<string | null>
            writeFile: (filePath: string, content: string) => Promise<boolean>
            revealFileInFolder: (filePath: string) => Promise<boolean>
            library: any
        }
    }
}
