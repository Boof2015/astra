export type ShortcutSectionId = 'global' | 'quick-launch' | 'contextual'

export type ShortcutToken =
  | 'mod'
  | 'shift'
  | 'alt'
  | 'enter'
  | 'esc'
  | 'space'
  | 'tab'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | '/'
  | '?'
  | 'k'
  | 'n'
  | 'p'
  | 'j'
  | 'm'
  | 's'
  | 'r'

export interface ShortcutBinding {
  tokens: ShortcutToken[]
}

export interface ShortcutDefinition {
  id: string
  section: ShortcutSectionId
  action: string
  description: string
  bindings: ShortcutBinding[]
}

export interface ShortcutSectionMeta {
  id: ShortcutSectionId
  label: string
  description: string
}

export const SEEK_STEP_SECONDS = 5
export const VOLUME_STEP = 0.05

export const SHORTCUT_SECTION_META: ShortcutSectionMeta[] = [
  {
    id: 'global',
    label: 'Global',
    description: 'Available throughout the app unless focus is inside a text field or dialog.'
  },
  {
    id: 'quick-launch',
    label: 'Quick Launch',
    description: 'Available while the Quick Launch palette is open.'
  },
  {
    id: 'contextual',
    label: 'Contextual',
    description: 'Available only when the matching view or control is visible.'
  }
]

const volumeStepPercent = Math.round(VOLUME_STEP * 100)

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  {
    id: 'quick-launch-open',
    section: 'global',
    action: 'Open Quick Launch',
    description: 'Open the in-app search palette.',
    bindings: [{ tokens: ['mod', 'k'] }]
  },
  {
    id: 'shortcuts-open',
    section: 'global',
    action: 'Open Keyboard Shortcuts',
    description: 'Show the shortcut reference modal.',
    bindings: [
      { tokens: ['?'] },
      { tokens: ['mod', '/'] }
    ]
  },
  {
    id: 'playback-toggle',
    section: 'global',
    action: 'Play / Pause',
    description: 'Toggle playback for the current track.',
    bindings: [{ tokens: ['space'] }]
  },
  {
    id: 'seek-forward',
    section: 'global',
    action: 'Seek Forward',
    description: `Move playback ahead ${SEEK_STEP_SECONDS} seconds.`,
    bindings: [{ tokens: ['right'] }]
  },
  {
    id: 'seek-backward',
    section: 'global',
    action: 'Seek Backward',
    description: `Move playback back ${SEEK_STEP_SECONDS} seconds.`,
    bindings: [{ tokens: ['left'] }]
  },
  {
    id: 'next-track',
    section: 'global',
    action: 'Next Track',
    description: 'Skip to the next track.',
    bindings: [
      { tokens: ['shift', 'right'] },
      { tokens: ['n'] }
    ]
  },
  {
    id: 'previous-track',
    section: 'global',
    action: 'Previous Track',
    description: 'Return to the previous track.',
    bindings: [
      { tokens: ['shift', 'left'] },
      { tokens: ['p'] }
    ]
  },
  {
    id: 'volume-up',
    section: 'global',
    action: 'Volume Up',
    description: `Increase volume by ${volumeStepPercent}%.`,
    bindings: [{ tokens: ['up'] }]
  },
  {
    id: 'volume-down',
    section: 'global',
    action: 'Volume Down',
    description: `Decrease volume by ${volumeStepPercent}%.`,
    bindings: [{ tokens: ['down'] }]
  },
  {
    id: 'jump-to-now-playing',
    section: 'global',
    action: 'Jump to Now Playing',
    description: 'Reveal the current track in the Library view.',
    bindings: [{ tokens: ['j'] }]
  },
  {
    id: 'mute',
    section: 'global',
    action: 'Mute',
    description: 'Toggle mute on or off.',
    bindings: [{ tokens: ['m'] }]
  },
  {
    id: 'shuffle',
    section: 'global',
    action: 'Shuffle',
    description: 'Toggle shuffle mode.',
    bindings: [{ tokens: ['s'] }]
  },
  {
    id: 'repeat',
    section: 'global',
    action: 'Repeat',
    description: 'Cycle repeat mode.',
    bindings: [{ tokens: ['r'] }]
  },
  {
    id: 'quick-launch-close',
    section: 'quick-launch',
    action: 'Close Quick Launch',
    description: 'Dismiss the palette.',
    bindings: [{ tokens: ['esc'] }]
  },
  {
    id: 'quick-launch-move',
    section: 'quick-launch',
    action: 'Move Selection',
    description: 'Move up or down through search results.',
    bindings: [
      { tokens: ['up'] },
      { tokens: ['down'] }
    ]
  },
  {
    id: 'quick-launch-open-selection',
    section: 'quick-launch',
    action: 'Open Selected Result',
    description: 'Run the highlighted result.',
    bindings: [{ tokens: ['enter'] }]
  },
  {
    id: 'quick-launch-toggle-track-action',
    section: 'quick-launch',
    action: 'Toggle Track Action',
    description: 'Switch a selected track result between play now and queue next.',
    bindings: [{ tokens: ['tab'] }]
  },
  {
    id: 'focus-search-field',
    section: 'contextual',
    action: 'Focus Search Field',
    description: 'Focus the visible Library or Metadata search input when one is on screen.',
    bindings: [{ tokens: ['/'] }]
  }
]

export function getShortcutTokenLabel(token: ShortcutToken, platform: NodeJS.Platform): string {
  switch (token) {
    case 'mod':
      return platform === 'darwin' ? 'Cmd' : 'Ctrl'
    case 'shift':
      return 'Shift'
    case 'alt':
      return platform === 'darwin' ? 'Option' : 'Alt'
    case 'enter':
      return 'Enter'
    case 'esc':
      return 'Esc'
    case 'space':
      return 'Space'
    case 'tab':
      return 'Tab'
    case 'up':
      return 'Up'
    case 'down':
      return 'Down'
    case 'left':
      return 'Left'
    case 'right':
      return 'Right'
    default:
      return token.toUpperCase()
  }
}
