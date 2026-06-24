import type { RawKeyboardBindingInput, RawMouseBindingInput } from '../types/inputBindings'
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
