import type { ControllerButtonRole, ControllerFamily } from '../../types/controller'
import { getControllerPromptLabels } from '../../utils/controllerGamepad'
import { getControllerGlyphKind } from '../../utils/controllerGlyph'

interface ControllerGlyphProps {
  family: ControllerFamily
  button: ControllerButtonRole
}

// PlayStation face buttons: geometric shapes.
function ShapeGlyph({ shape }: { shape: 'cross' | 'circle' | 'square' | 'triangle' }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {shape === 'cross' && (
        <path
          d="M7 7l10 10M17 7L7 17"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      )}
      {shape === 'circle' && (
        <circle cx="12" cy="12" r="6.6" fill="none" stroke="currentColor" strokeWidth="2.2" />
      )}
      {shape === 'square' && (
        <rect x="6" y="6" width="12" height="12" rx="1.6" fill="none" stroke="currentColor" strokeWidth="2.2" />
      )}
      {shape === 'triangle' && (
        <path
          d="M12 5.4l6.6 12.2H5.4z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
      )}
    </svg>
  )
}

// Xbox face buttons: a letter inside a ring.
function LetterGlyph({ letter }: { letter: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <text
        x="12"
        y="12.4"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="11"
        fontWeight="700"
        fill="currentColor"
      >
        {letter}
      </text>
    </svg>
  )
}

// Shoulder / trigger / stick: a button silhouette wrapping the hardware label
// (e.g. L1, RB, LT, R3) so each reads as a real controller button.
function LabelledGlyph({ variant, label }: { variant: 'bumper' | 'trigger' | 'stick'; label: string }) {
  if (variant === 'stick') {
    return (
      <svg viewBox="0 0 22 18" aria-hidden="true">
        <circle cx="11" cy="9" r="8" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <text
          x="11"
          y="9.3"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="9.5"
          fontWeight="700"
          fill="currentColor"
        >
          {label}
        </text>
      </svg>
    )
  }
  const trigger = variant === 'trigger'
  return (
    <svg viewBox="0 0 28 18" aria-hidden="true">
      <path
        d={
          trigger
            ? 'M5 3h18a4 4 0 0 1 4 4v2c0 3.6-3 5-7 5H8a4 4 0 0 1-4-4V7a4 4 0 0 1 1-4z'
            : 'M4 3h20a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z'
        }
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <text
        x="14"
        y={trigger ? '8.6' : '9.3'}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="10.5"
        fontWeight="700"
        fill="currentColor"
      >
        {label}
      </text>
    </svg>
  )
}

// Menu / Options: three stacked lines.
function MenuGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 8h12M6 12h12M6 16h12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export default function ControllerGlyph({ family, button }: ControllerGlyphProps) {
  const label = getControllerPromptLabels(family)[button]
  const kind = getControllerGlyphKind(family, button)
  return (
    <span className={`controller-glyph controller-glyph-${button}`} role="img" aria-label={label}>
      {kind.type === 'shape' && <ShapeGlyph shape={kind.shape} />}
      {kind.type === 'letter' && <LetterGlyph letter={kind.letter} />}
      {kind.type === 'labelled' && <LabelledGlyph variant={kind.variant} label={kind.label} />}
      {kind.type === 'menu' && <MenuGlyph />}
    </span>
  )
}
