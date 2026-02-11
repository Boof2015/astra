/// <reference types="vite/client" />

import { VisualizerDSP } from './audio/native/visualizer-dsp'

declare global {
    interface Window {
        visualizerAPI: VisualizerDSP | null
        electronAPI: {
            minimize: () => void
            maximize: () => void
            close: () => void
            isMaximized: () => Promise<boolean>
            platform: NodeJS.Platform
            getAppVersion: () => Promise<string>
            getAppPerformanceStats: () => Promise<{ cpuPercent: number; memoryMb: number }>
            discord: {
                configure: (options: { enabled: boolean; clientId: string }) => Promise<{ ok: boolean; connected: boolean; message: string }>
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
