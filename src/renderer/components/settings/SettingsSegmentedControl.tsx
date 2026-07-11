import type { CSSProperties } from 'react'

export interface SettingsSegmentedOption<T extends string | number> {
  value: T
  label: string
  disabled?: boolean
}

interface SettingsSegmentedControlProps<T extends string | number> {
  ariaLabel: string
  className?: string
  disabled?: boolean
  fullWidth?: boolean
  onChange: (value: T) => void
  options: readonly SettingsSegmentedOption<T>[]
  value: T
}

interface SettingsSegmentedStyle extends CSSProperties {
  '--segment-count': number
  '--segment-index': number
}

export default function SettingsSegmentedControl<T extends string | number>({
  ariaLabel,
  className = '',
  disabled = false,
  fullWidth = false,
  onChange,
  options,
  value,
}: SettingsSegmentedControlProps<T>) {
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const style: SettingsSegmentedStyle = {
    '--segment-count': Math.max(1, options.length),
    '--segment-index': selectedIndex,
  }

  return (
    <div
      className={`settings-segmented-control${fullWidth ? ' settings-segmented-control-full' : ''}${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={ariaLabel}
      style={style}
    >
      <span className="settings-segmented-highlight" aria-hidden="true" />
      {options.map((option) => {
        const isActive = option.value === value

        return (
          <button
            key={option.value}
            type="button"
            className={`settings-segmented-button${isActive ? ' active' : ''}`}
            onClick={() => onChange(option.value)}
            disabled={disabled || option.disabled}
            aria-pressed={isActive}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
