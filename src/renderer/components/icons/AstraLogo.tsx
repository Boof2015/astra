import {
  ASTRA_LOGO_BACKGROUND_FILL,
  ASTRA_LOGO_BG_PATH,
  ASTRA_LOGO_BG_TRANSFORM,
  ASTRA_LOGO_LEFT_PATH,
  ASTRA_LOGO_MAIN_FILL_CSS,
  ASTRA_LOGO_MAIN_TRANSFORM,
  ASTRA_LOGO_RIGHT_PATH,
  ASTRA_LOGO_SHADOW_FILL_CSS,
  ASTRA_LOGO_SHADOW_LEFT_TRANSFORM,
  ASTRA_LOGO_SHADOW_RIGHT_TRANSFORM,
  ASTRA_LOGO_SHADOW_TRANSFORM,
  ASTRA_LOGO_VIEWBOX,
} from './astraLogoShared'

interface AstraLogoProps {
  size?: number
  includeBackground?: boolean
  className?: string
}

export default function AstraLogo({
  size = 12,
  includeBackground = false,
  className,
}: AstraLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={ASTRA_LOGO_VIEWBOX}
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {includeBackground && (
        <g id="bg" transform={ASTRA_LOGO_BG_TRANSFORM}>
          <path d={ASTRA_LOGO_BG_PATH} fill={ASTRA_LOGO_BACKGROUND_FILL} />
        </g>
      )}

      <g id="shadow" transform={ASTRA_LOGO_SHADOW_TRANSFORM}>
        <g transform={ASTRA_LOGO_SHADOW_LEFT_TRANSFORM}>
          <path d={ASTRA_LOGO_LEFT_PATH} fill={ASTRA_LOGO_SHADOW_FILL_CSS} />
        </g>
        <g transform={ASTRA_LOGO_SHADOW_RIGHT_TRANSFORM}>
          <path d={ASTRA_LOGO_RIGHT_PATH} fill={ASTRA_LOGO_SHADOW_FILL_CSS} />
        </g>
      </g>

      <g id="main" transform={ASTRA_LOGO_MAIN_TRANSFORM}>
        <path d={ASTRA_LOGO_LEFT_PATH} fill={ASTRA_LOGO_MAIN_FILL_CSS} />
        <path d={ASTRA_LOGO_RIGHT_PATH} fill={ASTRA_LOGO_MAIN_FILL_CSS} />
      </g>
    </svg>
  )
}
