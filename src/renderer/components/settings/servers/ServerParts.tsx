import type { ReactNode } from 'react'
import { progressFraction, progressText, type ServerProgress } from './serverModel'

function Icon({ size = 14, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
  )
}

export const RefreshIcon = () => (
  <Icon size={13}>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />
  </Icon>
)
export const PlusIcon = () => <Icon size={13}><path d="M5 12h14" /><path d="M12 5v14" /></Icon>
export const AlertIcon = () => (
  <Icon size={15}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" />
  </Icon>
)

/**
 * On/off control for the server rows. Whether desktop uses switches or Astra's
 * "Enabled / Disabled" text toggles is still open, so it lives in one place.
 */
export function ServerSwitch({ checked, label, disabled, onChange }: {
  checked: boolean
  label: string
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button type="button" className="servers-switch" role="switch" aria-checked={checked} aria-label={label}
      disabled={disabled} onClick={() => onChange(!checked)} />
  )
}

/** The transport's loading bar: a fill once there's a total, the sweeping highlight before that. */
function ProgressBar({ progress }: { progress: ServerProgress }) {
  const fraction = progressFraction(progress)
  return (
    <div className={`transport-loading-hint-bar servers-progress-bar${fraction === null ? ' indeterminate' : ''}`}>
      <span className="transport-loading-hint-fill" style={fraction === null ? undefined : { width: `${(fraction * 100).toFixed(1)}%` }} />
    </div>
  )
}

/** List row: text over a thin bar, where the status would be. */
export function CompactProgress({ progress }: { progress: ServerProgress }) {
  return (
    <div className="servers-progress-compact" role="status">
      <span className="servers-progress-text">{progressText(progress)}</span>
      <ProgressBar progress={progress} />
    </div>
  )
}

/** Under a server's header: text and percentage over the bar. */
export function ProgressRow({ progress }: { progress: ServerProgress }) {
  const fraction = progressFraction(progress)
  return (
    <div className="servers-progress-row" role="status">
      <div className="servers-progress-head">
        <span className="servers-progress-text">{progressText(progress)}</span>
        {fraction !== null && <span className="servers-progress-pct">{Math.round(fraction * 100)}%</span>}
      </div>
      <ProgressBar progress={progress} />
    </div>
  )
}
