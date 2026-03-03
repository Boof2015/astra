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

declare global {
    interface Window {
        visualizerAPI: VisualizerDSP | null
        electronAPI: {
            minimize: () => void
            maximize: () => void
            close: () => void
            isMaximized: () => Promise<boolean>
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
            getAppPerformanceStats: () => Promise<{ cpuPercent: number; memoryMb: number }>
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
            decodeAudioWithFfmpeg: (filePath: string) => Promise<ArrayBuffer | null>
            getReplayGainScanEnabled: () => Promise<boolean>
            setReplayGainScanEnabled: (enabled: boolean) => Promise<boolean>
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
