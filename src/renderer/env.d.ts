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
            openAudioFile: () => Promise<any>
            openAudioFolder: () => Promise<string | null>
            loadAudioFile: (filePath: string) => Promise<any>
            library: any
        }
    }
}
