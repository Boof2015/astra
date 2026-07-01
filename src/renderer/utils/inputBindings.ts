import type {
  InputBinding,
  InputModifier,
  KeyboardBinding,
  RawKeyboardBindingInput
} from '../../types/inputBindings'

const MODIFIER_ORDER: readonly InputModifier[] = ['primary', 'control', 'alt', 'shift', 'meta']
const MODIFIER_KEYS = new Set(['alt', 'altgraph', 'control', 'meta', 'shift'])
const RESERVED_GLOBAL_KEYS = new Set(['escape', 'tab'])

function normalizeKey(rawKey: string, code = ''): string {
  const key = rawKey.trim().toLocaleLowerCase()
  if (code === 'NumpadAdd' || key === '=' || key === '+') return '+'
  if (code === 'NumpadSubtract' || key === '-') return '-'
  if (code === 'Numpad0' || key === '0') return '0'
  if (rawKey === ' ' || key === 'spacebar' || key === 'space') return 'space'
  return key
}

function normalizeModifiers(
  input: Pick<RawKeyboardBindingInput, 'key' | 'shift' | 'control' | 'alt' | 'meta'>,
  platform: NodeJS.Platform
): InputModifier[] {
  const modifiers = new Set<InputModifier>()
  const primaryDown = platform === 'darwin' ? input.meta : input.control

  if (primaryDown) modifiers.add('primary')
  if (platform === 'darwin' && input.control) modifiers.add('control')
  if (platform !== 'darwin' && input.meta) modifiers.add('meta')
  if (input.alt) modifiers.add('alt')

  const printableShiftedSymbol = input.key.length === 1 && !/[a-z0-9]/i.test(input.key)
  if (input.shift && !printableShiftedSymbol) modifiers.add('shift')

  return MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier))
}

export function normalizeRawKeyboardBinding(
  input: RawKeyboardBindingInput,
  platform: NodeJS.Platform
): KeyboardBinding | null {
  if (input.type !== 'keyDown') return null

  const key = normalizeKey(input.key, input.code)
  if (!key || key === 'unidentified' || MODIFIER_KEYS.has(key) || RESERVED_GLOBAL_KEYS.has(key)) {
    return null
  }

  return {
    device: 'keyboard',
    key,
    modifiers: normalizeModifiers(input, platform)
  }
}

export function keyboardEventToRawInput(event: KeyboardEvent): RawKeyboardBindingInput {
  return {
    device: 'keyboard',
    type: event.type === 'keyup' ? 'keyUp' : 'keyDown',
    key: event.key,
    code: event.code,
    repeat: event.repeat,
    shift: event.shiftKey,
    control: event.ctrlKey,
    alt: event.altKey,
    meta: event.metaKey
  }
}

export function inputBindingsEqual(left: InputBinding, right: InputBinding): boolean {
  if (left.device !== right.device) return false
  if (left.device === 'mouse' && right.device === 'mouse') return left.button === right.button
  if (left.device !== 'keyboard' || right.device !== 'keyboard') return false
  if (left.key !== right.key || left.modifiers.length !== right.modifiers.length) return false
  return left.modifiers.every((modifier, index) => modifier === right.modifiers[index])
}

export function cloneInputBinding(binding: InputBinding): InputBinding {
  return binding.device === 'mouse'
    ? { ...binding }
    : { ...binding, modifiers: [...binding.modifiers] }
}

export function sanitizeInputBinding(value: unknown): InputBinding | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<InputBinding> & Record<string, unknown>
  if (candidate.device === 'mouse') {
    return candidate.button === 'back' || candidate.button === 'forward'
      ? { device: 'mouse', button: candidate.button }
      : null
  }
  if (candidate.device !== 'keyboard' || typeof candidate.key !== 'string') return null

  const key = normalizeKey(candidate.key)
  if (!key || MODIFIER_KEYS.has(key) || RESERVED_GLOBAL_KEYS.has(key)) return null
  if (!Array.isArray(candidate.modifiers)) return null

  const modifiers = MODIFIER_ORDER.filter((modifier) => candidate.modifiers?.includes(modifier))
  if (modifiers.length !== candidate.modifiers.length) return null
  return { device: 'keyboard', key, modifiers }
}

function keyboardKeyLabel(key: string): string {
  switch (key) {
    case 'space': return 'Space'
    case 'arrowup': return 'Up'
    case 'arrowdown': return 'Down'
    case 'arrowleft': return 'Left'
    case 'arrowright': return 'Right'
    case 'enter': return 'Enter'
    case 'backspace': return 'Backspace'
    case 'delete': return 'Delete'
    case 'pageup': return 'Page Up'
    case 'pagedown': return 'Page Down'
    default: return key.length === 1 ? key.toLocaleUpperCase() : key
  }
}

export function formatInputBinding(binding: InputBinding, platform: NodeJS.Platform): string {
  if (binding.device === 'mouse') {
    return binding.button === 'back' ? 'Mouse 4 (Back)' : 'Mouse 5 (Forward)'
  }

  const modifierLabels = binding.modifiers.map((modifier) => {
    if (modifier === 'primary') return platform === 'darwin' ? 'Cmd' : 'Ctrl'
    if (modifier === 'control') return 'Ctrl'
    if (modifier === 'alt') return platform === 'darwin' ? 'Option' : 'Alt'
    if (modifier === 'meta') return platform === 'darwin' ? 'Cmd' : 'Meta'
    return 'Shift'
  })
  return [...modifierLabels, keyboardKeyLabel(binding.key)].join(' + ')
}
