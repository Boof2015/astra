import type { UIScaleShortcutAction } from '../types/uiScale'

export interface UIScaleShortcutInput {
  type?: string
  key?: string
  code?: string
  control?: boolean
  meta?: boolean
  alt?: boolean
}

function hasPlatformModifier(input: UIScaleShortcutInput, platform: NodeJS.Platform): boolean {
  return platform === 'darwin'
    ? input.meta === true
    : input.control === true
}

export function resolveUIScaleShortcutAction(
  input: UIScaleShortcutInput,
  platform: NodeJS.Platform
): UIScaleShortcutAction | null {
  if (input.type !== 'keyDown') return null
  if (input.alt === true) return null
  if (!hasPlatformModifier(input, platform)) return null

  const key = (input.key ?? '').toLowerCase()
  const code = input.code ?? ''

  if (key === '+' || key === '=' || code === 'Equal' || code === 'NumpadAdd') {
    return 'increase'
  }

  if (key === '-' || code === 'Minus' || code === 'NumpadSubtract') {
    return 'decrease'
  }

  if (key === '0' || code === 'Numpad0') {
    return 'reset'
  }

  return null
}
