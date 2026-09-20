import { useId } from 'react'

interface Props { modelId?: string | null; connected?: boolean; className?: string }

/** Artwork is chosen locally from a reported model ID, never loaded from a device URL. */
export default function HardwareIllustration({ modelId, connected = true, className = '' }: Props) {
  const id = useId().replace(/:/g, '')
  if (modelId !== 'astra-thing') return (
    <svg className={`hardware-illustration ${className}`} viewBox="0 0 420 240" fill="none" role="img" aria-label="Companion device">
      <rect x="62" y="40" width="296" height="168" rx="25" fill="var(--bg-tertiary)" stroke="var(--text-secondary)" strokeWidth="2" />
      <rect x="84" y="62" width="205" height="124" rx="7" fill="rgba(var(--tint), .045)" stroke="var(--glass-border)" />
      <circle cx="323" cy="103" r="21" fill="rgba(var(--tint), .1)" stroke="var(--text-secondary)" />
      <circle cx="323" cy="163" r="8" fill="var(--text-secondary)" />
      <path d="M170 124h34m-17-17v34" stroke="var(--text-secondary)" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
  return (
    <svg className={`hardware-illustration ${className}`} viewBox="0 0 420 240" fill="none" role="img" aria-label="Astra Thing">
      <defs>
        <linearGradient id={`${id}-body`} x1="210" y1="28" x2="210" y2="222" gradientUnits="userSpaceOnUse"><stop stopColor="#44494a"/><stop offset=".08" stopColor="#242828"/><stop offset=".82" stopColor="#151919"/><stop offset="1" stopColor="#333939"/></linearGradient>
        <linearGradient id={`${id}-dial`} x1="300" y1="50" x2="385" y2="146" gradientUnits="userSpaceOnUse"><stop stopColor="#424748"/><stop offset=".5" stopColor="#303535"/><stop offset="1" stopColor="#242929"/></linearGradient>
        <linearGradient id={`${id}-glass`} x1="38" y1="49" x2="297" y2="199" gradientUnits="userSpaceOnUse"><stop stopColor="#253e43"/><stop offset=".55" stopColor="#182b2e"/><stop offset="1" stopColor="#131d20"/></linearGradient>
        <linearGradient id={`${id}-edge`} x1="10" y1="34" x2="410" y2="222" gradientUnits="userSpaceOnUse"><stop stopColor="#949c9b"/><stop offset=".3" stopColor="#535c5b"/><stop offset="1" stopColor="#333b3a"/></linearGradient>
      </defs>
      <ellipse cx="209" cy="225" rx="168" ry="6" fill="#000" opacity=".12" />
      <g fill="#383e3e" stroke="#667170" strokeWidth="1"><rect x="81" y="23" width="35" height="7" rx="3"/><rect x="145" y="23" width="35" height="7" rx="3"/><rect x="209" y="23" width="35" height="7" rx="3"/><rect x="273" y="23" width="35" height="7" rx="3"/></g>
      <rect x="9" y="29" width="402" height="193" rx="25" fill={`url(#${id}-body)`} stroke={`url(#${id}-edge)`} strokeWidth="2"/>
      <rect x="16" y="35" width="388" height="180" rx="20" fill="#111515" stroke="#3b4241"/>
      <rect x="34" y="51" width="265" height="148" rx="6" fill={connected ? `url(#${id}-glass)` : '#182021'}/>
      <path d="M40 53h254" stroke="#9cc4c6" opacity=".12"/>
      <image href="./devices/astra-lockup.svg" x="72" y="110" width="175" height="20" opacity={connected ? 1 : .45}/>
      <rect x="47" y="183" width="232" height="2" rx="1" fill="#99b8b6" opacity=".2"/>
      <rect x="47" y="183" width={connected ? 93 : 0} height="2" rx="1" fill="#9bd0d3" opacity=".8"/>
      <circle cx="346" cy="98" r="57" fill="#080b0b" opacity=".8"/>
      <circle cx="345" cy="94" r="54" fill={`url(#${id}-dial)`} stroke="#626b69" strokeWidth="1.2"/>
      <circle cx="345" cy="94" r="50.5" stroke="#66726e" opacity=".22"/>
      <circle cx="345" cy="94" r="50.5" pathLength="360" strokeDasharray="100 260" transform="rotate(-140 345 94)" stroke="#a9b4b0" opacity=".13" strokeLinecap="round"/>
      <circle cx="345" cy="180" r="18" fill={`url(#${id}-dial)`} stroke="#5b6461"/>
    </svg>
  )
}

export function ConnectionIllustration() {
  return <svg className="hardware-connect-art" viewBox="0 0 420 210" fill="none" role="img" aria-label="Connect hardware to your computer with a USB cable">
    <rect x="40" y="27" width="204" height="133" rx="10" fill="var(--bg-tertiary)" stroke="var(--text-secondary)" strokeWidth="2"/>
    <rect x="50" y="37" width="184" height="107" rx="3" fill="#182021"/>
    <image href="./devices/astra-lockup.svg" x="66" y="82" width="152" height="17"/>
    <path d="M112 181h61m-42-20-4 20m28-20 4 20" stroke="var(--text-secondary)" strokeWidth="3" strokeLinecap="round"/>
    <path d="M247 108h23c40 0 26 60 63 60h26" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round"/>
    <rect x="349" y="157" width="24" height="22" rx="5" fill="var(--bg-secondary)" stroke="var(--accent)" strokeWidth="2"/>
    <path d="M373 163h9v10h-9" stroke="var(--accent)" strokeWidth="2"/>
  </svg>
}
