// Track metadata
export interface Track {
  id: string
  path: string
  origin?: 'library' | 'associated-external'
  title: string
  artist: string
  artistNames?: string[]
  album: string
  albumArtist?: string
  albumArtistNames?: string[]
  albumIdentityKey?: string
  duration: number
  trackNumber?: number
  discNumber?: number
  year?: number
  genre?: string
  genres?: string[]
  artworkData?: string  // Base64 data URL fallback for uncached direct artwork
  artworkHash?: string  // Hash for cached artwork
  format: string
  sampleRate?: number
  bitDepth?: number
  bitrate?: number
  channels?: number
  codec?: string
  codecProfile?: string
  isAtmosJoc?: boolean
  /** Eclipsa Audio (IAMF) source — decoded by the wasm worker to 7.1.4. */
  isIamf?: boolean
  replayGainTrackDb?: number
  replayGainAlbumDb?: number
  sourceType?: 'local' | 'subsonic' | 'jellyfin'
  sourceId?: number
  sourceTrackId?: string
  sourcePath?: string
  isAvailable?: boolean
  availabilityReason?: string
}

// Playback state
export type PlaybackState = 'stopped' | 'playing' | 'paused' | 'loading'

// Player store state
export interface PlayerState {
  currentTrack: Track | null
  playbackState: PlaybackState
  currentTime: number
  duration: number
  volume: number
  isMuted: boolean
}

// Audio engine events
export interface AudioEngineEvents {
  stateChange: (state: PlaybackState) => void
  timeUpdate: (currentTime: number) => void
  durationChange: (duration: number) => void
  ended: () => void
  error: (error: Error) => void
}

// EQ Band
export interface EQBand {
  id: string
  type: 'lowshelf' | 'peaking' | 'highshelf' | 'highpass' | 'lowpass'
  frequency: number
  gain: number
  Q: number
}

// EQ Preset
export interface EQPreset {
  id: string
  name: string
  bands: EQBand[]
  preamp: number
  isCustom?: boolean
}

// Visualizer config
export interface VisualizerConfig {
  type: 'oscilloscope' | 'spectrum' | 'spectrogram' | 'vu' | 'loudness' | 'stereo'
  fftSize: 1024 | 2048 | 4096 | 8192 | 16384
  pitchLock?: boolean
  scale?: 'linear' | 'log' | 'mel'
}
