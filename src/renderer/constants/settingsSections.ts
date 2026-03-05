export const SETTINGS_SECTIONS = [
  {
    id: 'appearance',
    label: 'Appearance',
    keywords: ['theme', 'accent', 'cover art', 'color', 'visual', 'dark', 'light', 'background']
  },
  {
    id: 'library',
    label: 'Library',
    keywords: ['folders', 'rescan', 'scan', 'music', 'metadata', 'import', 'path', 'replaygain', 'normalization', 'loudness', 'gain']
  },
  {
    id: 'analyzer',
    label: 'Analyzer',
    keywords: ['fft', 'visualizer', 'pitch lock', 'oscilloscope', 'spectrum', 'equalizer', 'eq', 'waveform']
  },
  {
    id: 'audio',
    label: 'Audio Output',
    keywords: ['output', 'device', 'routing', 'delay', 'channel', 'sample rate', 'bit depth', 'buffer', 'latency']
  },
  {
    id: 'playback',
    label: 'Playback',
    keywords: ['sleep timer', 'timer', 'countdown', 'pause', 'gapless', 'crossfade', 'shuffle', 'repeat']
  },
  {
    id: 'integrations',
    label: 'Integrations',
    keywords: ['discord', 'local api', 'api key', 'port', 'controls', 'remote', 'webhook', 'last.fm', 'lastfm', 'scrobble', 'scrobbling', 'lyrics', 'lyric', 'lrclib', 'subsonic', 'navidrome']
  },
  {
    id: 'info',
    label: 'Info',
    keywords: ['version', 'updates', 'license', 'support', 'about', 'changelog']
  },
  {
    id: 'danger',
    label: 'Danger Zone',
    keywords: ['reset', 'factory reset', 'clear', 'danger', 'troubleshoot', 'delete', 'wipe']
  }
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

export interface NavEntry {
  id: string
  label: string
  view: 'home' | 'library' | 'eq' | 'settings' | 'playlist' | 'metadata'
  keywords: string[]
}

export const NAV_ENTRIES: NavEntry[] = [
  { id: 'nav:eq', label: 'Equalizer', view: 'eq', keywords: ['eq', 'equalizer', 'bands', 'frequency', 'bass', 'treble'] },
  { id: 'nav:library', label: 'Library', view: 'library', keywords: ['library', 'tracks', 'songs', 'browse', 'collection'] },
  { id: 'nav:home', label: 'Home', view: 'home', keywords: ['home', 'dashboard', 'main'] },
  { id: 'nav:playlist', label: 'Playlists', view: 'playlist', keywords: ['playlist', 'playlists', 'list'] },
  { id: 'nav:metadata', label: 'Metadata Editor', view: 'metadata', keywords: ['metadata', 'tags', 'editor', 'tag', 'id3'] }
]
