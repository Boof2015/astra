/// <reference types="vite/client" />

import { VisualizerDSP } from './audio/native/visualizer-dsp'
import type { MiniPlayerCommand, MiniPlayerSnapshot, MiniPlayerWindowState } from '../types/miniPlayer'

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
                toggleAlwaysOnTop: () => Promise<MiniPlayerWindowState>
                getSnapshot: () => Promise<MiniPlayerSnapshot | null>
                publishSnapshot: (snapshot: MiniPlayerSnapshot) => void
                sendCommand: (command: MiniPlayerCommand) => void
                onSnapshot: (callback: (snapshot: MiniPlayerSnapshot) => void) => () => void
                onCommand: (callback: (command: MiniPlayerCommand) => void) => () => void
                onWindowState: (callback: (state: MiniPlayerWindowState) => void) => () => void
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
                openReleasesPage: () => Promise<boolean>
            }
            theme: {
                setRuntimeIconDataUrl: (dataUrl: string) => void
            }
            discord: {
                configure: (options: { enabled: boolean }) => Promise<{ ok: boolean; connected: boolean; message: string }>
                updatePresence: (update: {
                    playbackState: 'stopped' | 'playing' | 'paused' | 'loading'
                    currentTimeSeconds?: number
                    durationSeconds?: number
                    track?: {
                        title: string
                        artist?: string
                        album?: string
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
            }
            openAudioFile: () => Promise<any>
            openAudioFolder: () => Promise<string | null>
            loadAudioFile: (filePath: string) => Promise<any>
            decodeAudioWithFfmpeg: (filePath: string) => Promise<ArrayBuffer | null>
            library: any
        }
    }
}
