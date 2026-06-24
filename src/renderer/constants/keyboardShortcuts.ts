import type {
  InputActionId,
  InputBinding,
  InputModifier,
  KeyboardBinding,
  MouseBinding
} from '../../types/inputBindings'

export type InputActionGroup = 'app' | 'playback' | 'navigation'

export interface InputActionDefinition {
  id: InputActionId
  group: InputActionGroup
  action: string
  description: string
  defaultBindings: readonly InputBinding[]
  allowRepeat?: boolean
}

export const SEEK_STEP_SECONDS = 5
export const VOLUME_STEP = 0.05
export const MAX_BINDINGS_PER_ACTION = 2

const keyboard = (key: string, modifiers: InputModifier[] = []): KeyboardBinding => ({
  device: 'keyboard',
  key,
  modifiers
})

const mouse = (button: MouseBinding['button']): MouseBinding => ({ device: 'mouse', button })

export const INPUT_ACTION_GROUPS: ReadonlyArray<{
  id: InputActionGroup
  label: string
  description: string
}> = [
  { id: 'app', label: 'App', description: 'App-wide commands and interface scaling.' },
  { id: 'playback', label: 'Playback', description: 'Playback, seeking, and volume controls.' },
  { id: 'navigation', label: 'Navigation', description: 'Move around Astra and focus the current view.' }
]

export const INPUT_ACTION_DEFINITIONS: readonly InputActionDefinition[] = [
  {
    id: 'quick-launch-open',
    group: 'app',
    action: 'Open Quick Launch',
    description: 'Open the in-app search palette.',
    defaultBindings: [keyboard('k', ['primary'])]
  },
  {
    id: 'keybinds-open',
    group: 'app',
    action: 'Open Keybind Settings',
    description: 'Open this Keybinds settings page.',
    defaultBindings: [keyboard('?'), keyboard('/', ['primary'])]
  },
  {
    id: 'ui-scale-increase',
    group: 'app',
    action: 'Increase UI Scale',
    description: 'Increase the app interface scale.',
    defaultBindings: [keyboard('+', ['primary'])],
    allowRepeat: true
  },
  {
    id: 'ui-scale-decrease',
    group: 'app',
    action: 'Decrease UI Scale',
    description: 'Decrease the app interface scale.',
    defaultBindings: [keyboard('-', ['primary'])],
    allowRepeat: true
  },
  {
    id: 'ui-scale-reset',
    group: 'app',
    action: 'Reset UI Scale',
    description: 'Reset the app interface scale.',
    defaultBindings: [keyboard('0', ['primary'])]
  },
  {
    id: 'playback-toggle',
    group: 'playback',
    action: 'Play / Pause',
    description: 'Toggle playback for the current track.',
    defaultBindings: [keyboard('space')]
  },
  {
    id: 'seek-forward',
    group: 'playback',
    action: 'Seek Forward',
    description: `Move playback ahead ${SEEK_STEP_SECONDS} seconds.`,
    defaultBindings: [keyboard('arrowright')]
  },
  {
    id: 'seek-backward',
    group: 'playback',
    action: 'Seek Backward',
    description: `Move playback back ${SEEK_STEP_SECONDS} seconds.`,
    defaultBindings: [keyboard('arrowleft')]
  },
  {
    id: 'next-track',
    group: 'playback',
    action: 'Next Track',
    description: 'Skip to the next track.',
    defaultBindings: [keyboard('arrowright', ['shift']), keyboard('n')]
  },
  {
    id: 'previous-track',
    group: 'playback',
    action: 'Previous Track',
    description: 'Return to the previous track.',
    defaultBindings: [keyboard('arrowleft', ['shift']), keyboard('p')]
  },
  {
    id: 'volume-up',
    group: 'playback',
    action: 'Volume Up',
    description: `Increase volume by ${Math.round(VOLUME_STEP * 100)}%.`,
    defaultBindings: [keyboard('arrowup')],
    allowRepeat: true
  },
  {
    id: 'volume-down',
    group: 'playback',
    action: 'Volume Down',
    description: `Decrease volume by ${Math.round(VOLUME_STEP * 100)}%.`,
    defaultBindings: [keyboard('arrowdown')],
    allowRepeat: true
  },
  {
    id: 'jump-to-now-playing',
    group: 'navigation',
    action: 'Jump to Now Playing',
    description: 'Reveal the current track using the configured destination.',
    defaultBindings: [keyboard('j')]
  },
  {
    id: 'focus-search-field',
    group: 'navigation',
    action: 'Focus Search Field',
    description: 'Focus the visible Library search input.',
    defaultBindings: [keyboard('/')]
  },
  {
    id: 'navigate-back',
    group: 'navigation',
    action: 'Navigate Back',
    description: 'Return through Library details, then previous app views.',
    defaultBindings: [mouse('back')]
  },
  {
    id: 'navigate-forward',
    group: 'navigation',
    action: 'Navigate Forward',
    description: 'Move forward through Library details or app views.',
    defaultBindings: [mouse('forward')]
  },
  {
    id: 'mute',
    group: 'playback',
    action: 'Mute',
    description: 'Toggle mute on or off.',
    defaultBindings: [keyboard('m')]
  },
  {
    id: 'shuffle',
    group: 'playback',
    action: 'Shuffle',
    description: 'Toggle shuffle mode.',
    defaultBindings: [keyboard('s')]
  },
  {
    id: 'repeat',
    group: 'playback',
    action: 'Repeat',
    description: 'Cycle repeat mode.',
    defaultBindings: [keyboard('r')]
  }
]

export const INPUT_ACTION_IDS = new Set<InputActionId>(
  INPUT_ACTION_DEFINITIONS.map((definition) => definition.id)
)

export function getInputActionDefinition(actionId: InputActionId): InputActionDefinition {
  const definition = INPUT_ACTION_DEFINITIONS.find((candidate) => candidate.id === actionId)
  if (!definition) throw new Error(`Unknown input action: ${actionId}`)
  return definition
}
