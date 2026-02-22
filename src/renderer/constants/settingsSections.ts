export const SETTINGS_SECTIONS = [
  {
    id: 'appearance',
    label: 'Appearance',
    keywords: ['theme', 'accent', 'cover art', 'color', 'visual']
  },
  {
    id: 'library',
    label: 'Library',
    keywords: ['folders', 'rescan', 'scan', 'music', 'metadata']
  },
  {
    id: 'analyzer',
    label: 'Analyzer',
    keywords: ['fft', 'visualizer', 'pitch lock', 'oscilloscope', 'spectrum']
  },
  {
    id: 'audio',
    label: 'Audio Output',
    keywords: ['output', 'device', 'routing', 'delay', 'channel']
  },
  {
    id: 'playback',
    label: 'Playback',
    keywords: ['sleep timer', 'timer', 'countdown', 'pause']
  },
  {
    id: 'integrations',
    label: 'Integrations',
    keywords: ['discord', 'local api', 'api key', 'port', 'controls']
  },
  {
    id: 'info',
    label: 'Info',
    keywords: ['version', 'updates', 'license', 'support', 'about']
  },
  {
    id: 'danger',
    label: 'Danger Zone',
    keywords: ['reset', 'factory reset', 'clear', 'danger', 'troubleshoot']
  }
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']
