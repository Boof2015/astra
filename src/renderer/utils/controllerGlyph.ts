import type { ControllerButtonRole, ControllerFamily } from '../types/controller'
import { getControllerPromptLabels } from './controllerGamepad'

export type ControllerGlyphKind =
  | { type: 'shape'; shape: 'cross' | 'circle' | 'square' | 'triangle' }
  | { type: 'letter'; letter: string }
  | { type: 'labelled'; variant: 'bumper' | 'trigger' | 'stick'; label: string }
  | { type: 'menu' }

/**
 * Maps a controller family + button role to the kind of glyph to draw. Kept free of
 * JSX so it can be unit-tested under the type-stripping test runner, and so the render
 * layer stays a thin switch over these kinds. Every role resolves to a concrete glyph
 * for both families (no silent text fallback).
 */
export function getControllerGlyphKind(
  family: ControllerFamily,
  button: ControllerButtonRole
): ControllerGlyphKind {
  const labels = getControllerPromptLabels(family)
  switch (button) {
    case 'radialMenu':
      return { type: 'menu' }
    case 'bumperLeft':
      return { type: 'labelled', variant: 'bumper', label: labels.bumperLeft }
    case 'bumperRight':
      return { type: 'labelled', variant: 'bumper', label: labels.bumperRight }
    case 'triggerLeft':
      return { type: 'labelled', variant: 'trigger', label: labels.triggerLeft }
    case 'triggerRight':
      return { type: 'labelled', variant: 'trigger', label: labels.triggerRight }
    case 'stickLeft':
      return { type: 'labelled', variant: 'stick', label: labels.stickLeft }
    case 'stickRight':
      return { type: 'labelled', variant: 'stick', label: labels.stickRight }
  }

  // Face buttons: PlayStation shows geometric shapes, Xbox shows lettered buttons.
  if (family === 'playstation') {
    switch (button) {
      case 'activate':
        return { type: 'shape', shape: 'cross' }
      case 'back':
        return { type: 'shape', shape: 'circle' }
      case 'playPause':
        return { type: 'shape', shape: 'square' }
      case 'queue':
        return { type: 'shape', shape: 'triangle' }
    }
  }
  return { type: 'letter', letter: labels[button] }
}
