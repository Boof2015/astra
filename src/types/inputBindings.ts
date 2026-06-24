export const INPUT_ACTION_ID_VALUES = [
  'quick-launch-open',
  'keybinds-open',
  'ui-scale-increase',
  'ui-scale-decrease',
  'ui-scale-reset',
  'playback-toggle',
  'seek-forward',
  'seek-backward',
  'next-track',
  'previous-track',
  'volume-up',
  'volume-down',
  'jump-to-now-playing',
  'mute',
  'shuffle',
  'repeat',
  'focus-search-field',
  'navigate-back',
  'navigate-forward'
] as const

export type InputActionId = (typeof INPUT_ACTION_ID_VALUES)[number]

export function isInputActionId(value: unknown): value is InputActionId {
  return typeof value === 'string' && (INPUT_ACTION_ID_VALUES as readonly string[]).includes(value)
}

export type InputModifier = 'primary' | 'control' | 'alt' | 'shift' | 'meta'

export interface KeyboardBinding {
  device: 'keyboard'
  key: string
  modifiers: InputModifier[]
}

export interface MouseBinding {
  device: 'mouse'
  button: 'back' | 'forward'
}

export type InputBinding = KeyboardBinding | MouseBinding

export interface RawKeyboardBindingInput {
  device: 'keyboard'
  type: 'keyDown' | 'keyUp'
  key: string
  code: string
  repeat: boolean
  shift: boolean
  control: boolean
  alt: boolean
  meta: boolean
}

export interface RawMouseBindingInput {
  device: 'mouse'
  button: 'back' | 'forward'
}

export type RawBindingInput = RawKeyboardBindingInput | RawMouseBindingInput

export interface GlobalShortcutRegistrationRequest {
  actionId: InputActionId
  slotIndex: 0 | 1
  binding: KeyboardBinding
}

export type GlobalShortcutRegistrationState = 'registered' | 'unavailable' | 'unsupported'

export interface GlobalShortcutRegistrationResult {
  actionId: InputActionId
  slotIndex: 0 | 1
  state: GlobalShortcutRegistrationState
  accelerator: string | null
  message: string
}
