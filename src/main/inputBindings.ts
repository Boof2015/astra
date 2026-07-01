import {
  isInputActionId,
  type GlobalShortcutRegistrationRequest,
  type InputModifier,
  type KeyboardBinding,
  type RawKeyboardBindingInput,
  type RawMouseBindingInput
} from '../types/inputBindings'
import { resolveUIScaleShortcutAction, type UIScaleShortcutInput } from './uiScaleShortcuts'

export interface InterceptedKeyboardInput extends UIScaleShortcutInput {
  key?: string
  code?: string
  isAutoRepeat?: boolean
  shift?: boolean
  control?: boolean
  alt?: boolean
  meta?: boolean
}

export function resolveInterceptedKeyboardInput(
  input: InterceptedKeyboardInput,
  platform: NodeJS.Platform
): RawKeyboardBindingInput | null {
  if (!resolveUIScaleShortcutAction(input, platform)) return null
  return {
    device: 'keyboard',
    type: input.type === 'keyUp' ? 'keyUp' : 'keyDown',
    key: input.key ?? '',
    code: input.code ?? '',
    repeat: input.isAutoRepeat === true,
    shift: input.shift === true,
    control: input.control === true,
    alt: input.alt === true,
    meta: input.meta === true
  }
}

export function resolveMouseAppCommand(command: string): RawMouseBindingInput | null {
  if (command === 'browser-backward') return { device: 'mouse', button: 'back' }
  if (command === 'browser-forward') return { device: 'mouse', button: 'forward' }
  return null
}

const ACCELERATOR_MODIFIERS: Record<InputModifier, string> = {
  primary: 'CommandOrControl',
  control: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Super'
}

const NAMED_ACCELERATOR_KEYS: Record<string, string> = {
  space: 'Space',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  enter: 'Enter',
  return: 'Enter',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  escape: 'Escape',
  volumeup: 'VolumeUp',
  volumedown: 'VolumeDown',
  volumemute: 'VolumeMute',
  mediatracknext: 'MediaNextTrack',
  mediatrackprevious: 'MediaPreviousTrack',
  mediastop: 'MediaStop',
  mediaplaypause: 'MediaPlayPause',
  '+': 'Plus'
}

function resolveAcceleratorKey(key: string): string | null {
  const normalized = key.trim().toLocaleLowerCase()
  if (!normalized) return null
  const named = NAMED_ACCELERATOR_KEYS[normalized]
  if (named) return named
  if (/^[a-z0-9]$/.test(normalized)) return normalized.toUpperCase()
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(normalized)) return normalized.toUpperCase()
  if (normalized.length === 1) return normalized
  return null
}

export function keyboardBindingToAccelerator(binding: KeyboardBinding): string | null {
  const key = resolveAcceleratorKey(binding.key)
  if (!key) return null
  const modifiers = binding.modifiers.map((modifier) => ACCELERATOR_MODIFIERS[modifier])
  return [...new Set(modifiers), key].join('+')
}

export function sanitizeGlobalShortcutRegistrationRequests(
  value: unknown
): GlobalShortcutRegistrationRequest[] {
  if (!Array.isArray(value)) return []
  const requests: GlobalShortcutRegistrationRequest[] = []
  for (const candidate of value.slice(0, 64)) {
    if (!candidate || typeof candidate !== 'object') continue
    const raw = candidate as Partial<GlobalShortcutRegistrationRequest>
    if (!isInputActionId(raw.actionId) || (raw.slotIndex !== 0 && raw.slotIndex !== 1)) continue
    const binding = raw.binding
    if (!binding || binding.device !== 'keyboard' || typeof binding.key !== 'string' || !Array.isArray(binding.modifiers)) continue
    if (!binding.modifiers.every((modifier) => modifier in ACCELERATOR_MODIFIERS)) continue
    requests.push({
      actionId: raw.actionId,
      slotIndex: raw.slotIndex,
      binding: { device: 'keyboard', key: binding.key, modifiers: [...binding.modifiers] }
    })
  }
  return requests
}
