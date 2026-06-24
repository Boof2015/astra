export type InputActionId =
  | 'quick-launch-open'
  | 'keybinds-open'
  | 'ui-scale-increase'
  | 'ui-scale-decrease'
  | 'ui-scale-reset'
  | 'playback-toggle'
  | 'seek-forward'
  | 'seek-backward'
  | 'next-track'
  | 'previous-track'
  | 'volume-up'
  | 'volume-down'
  | 'jump-to-now-playing'
  | 'mute'
  | 'shuffle'
  | 'repeat'
  | 'focus-search-field'
  | 'navigate-back'
  | 'navigate-forward'

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
