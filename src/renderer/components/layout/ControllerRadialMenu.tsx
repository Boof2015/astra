import type { ControllerFamily } from '../../types/controller'
import {
  clampControllerRadialIndex,
  createControllerRadialRoot,
  getControllerRadialView,
  type ControllerRadialItem,
  type ControllerRadialMenuState
} from '../../utils/controllerRadial'
import { useUIStore } from '../../stores/uiStore'
import ControllerGlyph from './ControllerGlyph'

interface ControllerRadialMenuProps {
  active: boolean
  family: ControllerFamily
  canOpenContext: boolean
  radialMenu: ControllerRadialMenuState
}

interface Point {
  x: number
  y: number
}

interface RadialSliceGeometry {
  startAngle: number
  endAngle: number
  middleAngle: number
  path: string
  accentPath: string
  iconPoint: Point
}

interface AimGeometry {
  end: Point
  dot: Point
}

const RADIAL_CENTER = 220
const RADIAL_OUTER_RADIUS = 174
const RADIAL_INNER_RADIUS = 86
const RADIAL_ICON_RADIUS = 131
const RADIAL_AIM_MIN_LENGTH = 44
const RADIAL_AIM_MAX_LENGTH = 146
const RADIAL_VIEWBOX = `0 0 ${RADIAL_CENTER * 2} ${RADIAL_CENTER * 2}`

function polarPoint(radius: number, angle: number): Point {
  return {
    x: RADIAL_CENTER + Math.cos(angle) * radius,
    y: RADIAL_CENTER + Math.sin(angle) * radius
  }
}

function annularSectorPath(
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number
): string {
  const outerStart = polarPoint(outerRadius, startAngle)
  const outerEnd = polarPoint(outerRadius, endAngle)
  const innerEnd = polarPoint(innerRadius, endAngle)
  const innerStart = polarPoint(innerRadius, startAngle)
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0
  return [
    `M ${outerStart.x.toFixed(3)} ${outerStart.y.toFixed(3)}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x.toFixed(3)} ${outerEnd.y.toFixed(3)}`,
    `L ${innerEnd.x.toFixed(3)} ${innerEnd.y.toFixed(3)}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x.toFixed(3)} ${innerStart.y.toFixed(3)}`,
    'Z'
  ].join(' ')
}

function getSliceGeometry(index: number, itemCount: number): RadialSliceGeometry {
  const sliceSize = (Math.PI * 2) / Math.max(1, itemCount)
  const baseStart = -Math.PI / 2 + sliceSize * index
  // Wedges meet edge-to-edge; adjacent hairline strokes form the divider between them.
  const startAngle = baseStart
  const endAngle = baseStart + sliceSize
  const middleAngle = (startAngle + endAngle) / 2
  return {
    startAngle,
    endAngle,
    middleAngle,
    path: annularSectorPath(RADIAL_INNER_RADIUS, RADIAL_OUTER_RADIUS, startAngle, endAngle),
    accentPath: annularSectorPath(RADIAL_INNER_RADIUS - 2, RADIAL_INNER_RADIUS + 7, startAngle, endAngle),
    iconPoint: polarPoint(RADIAL_ICON_RADIUS, middleAngle)
  }
}

function getAimGeometry(vector: ControllerRadialMenuState['aimVector']): AimGeometry | null {
  if (!vector) return null
  const magnitude = Math.min(1, Math.hypot(vector.x, vector.y))
  if (magnitude < 0.08) return null
  const angle = Math.atan2(vector.y, vector.x)
  const length = Math.max(RADIAL_AIM_MIN_LENGTH, magnitude * RADIAL_AIM_MAX_LENGTH)
  return {
    end: polarPoint(length, angle),
    dot: polarPoint(Math.min(RADIAL_OUTER_RADIUS - 22, length + 8), angle)
  }
}

function RadialGlyph({ item }: { item: ControllerRadialItem }) {
  const id = item.id
  switch (id) {
    case 'browse':
    case 'search':
    case 'quick-launch':
      return (
        <>
          <circle cx="10" cy="10" r="5" />
          <path d="M14 14l5 5" />
        </>
      )
    case 'playback':
    case 'play-pause':
      return <path d="M8 5l10 7-10 7V5z" />
    case 'queue':
      return (
        <>
          <path d="M5 7h14M5 12h14M5 17h9" />
          <path d="M17 16l3 2-3 2v-4z" />
        </>
      )
    case 'volume':
    case 'volume-up':
      return (
        <>
          <path d="M4 14H8l5 4V6L8 10H4v4z" />
          <path d="M16 9c1.6 1.6 1.6 4.4 0 6M18.5 6.5c3 3 3 8 0 11" />
        </>
      )
    case 'volume-down':
      return (
        <>
          <path d="M4 14H8l5 4V6L8 10H4v4z" />
          <path d="M16 9c1.6 1.6 1.6 4.4 0 6" />
        </>
      )
    case 'mute':
      return (
        <>
          <path d="M4 14H8l5 4V6L8 10H4v4z" />
          <path d="M17 10l4 4M21 10l-4 4" />
        </>
      )
    case 'more':
      return (
        <>
          <circle cx="7" cy="12" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="17" cy="12" r="1.5" />
        </>
      )
    case 'next-tab':
    case 'forward':
    case 'next-track':
    case 'seek-forward':
      return (
        <>
          <path d="M7 5l7 7-7 7" />
          <path d="M14 5l7 7-7 7" />
        </>
      )
    case 'previous-tab':
    case 'back':
    case 'previous-track':
    case 'seek-backward':
      return (
        <>
          <path d="M17 5l-7 7 7 7" />
          <path d="M10 5l-7 7 7 7" />
        </>
      )
    case 'now-playing':
      return <path d="M9 18a3 3 0 1 1-2-2.83V5h11v10a3 3 0 1 1-2-2.83V8H9v10z" />
    case 'shuffle':
      return <path d="M4 7h3c5 0 5 10 10 10h3M17 4l4 3-4 3M4 17h3c1.6 0 2.8-1 3.8-2.4M17 14l4 3-4 3M14 9.3C15 8 16 7 17 7h3" />
    case 'repeat':
      return <path d="M7 7h9l-3-3M17 17H8l3 3M17 7c2 1 3 3 3 5M7 17c-2-1-3-3-3-5" />
    case 'sidebar':
      return (
        <>
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M9 5v14" />
        </>
      )
    default:
      return <path d="M12 5v14M5 12h14" />
  }
}

export default function ControllerRadialMenu({
  active,
  family,
  canOpenContext,
  radialMenu
}: ControllerRadialMenuProps) {
  const showQueue = useUIStore((state) => state.showQueue)
  if (!active || !radialMenu.open) return null

  const root = createControllerRadialRoot({ canOpenContext, showQueue })
  const view = getControllerRadialView(root, radialMenu.path)
  const selectedIndex = clampControllerRadialIndex(radialMenu.selectedIndex, view.items.length)
  const selectedItem = view.items[selectedIndex] ?? null
  const backLabel = radialMenu.path.length > 0 ? 'Back' : 'Close'
  const aimGeometry = getAimGeometry(radialMenu.aimVector)
  const selectedHint = selectedItem?.disabled
    ? 'Unavailable'
    : selectedItem?.children?.length
      ? 'Open'
      : selectedItem?.keepOpen
        ? 'Repeat'
        : 'Select'

  return (
    <div className="controller-radial-menu" aria-hidden="true">
      <div className="controller-radial-scrim" />
      <div className="controller-radial-wheel">
        <svg className="controller-radial-svg" viewBox={RADIAL_VIEWBOX}>
          <circle className="controller-radial-backplate" cx={RADIAL_CENTER} cy={RADIAL_CENTER} r={RADIAL_OUTER_RADIUS + 12} />
          <circle className="controller-radial-inner-shadow" cx={RADIAL_CENTER} cy={RADIAL_CENTER} r={RADIAL_INNER_RADIUS - 8} />
          {view.items.map((item, index) => {
            const geometry = getSliceGeometry(index, view.items.length)
            const selected = index === selectedIndex
            return (
              <g
                key={item.id}
                className={[
                  'controller-radial-segment',
                  selected ? 'is-selected' : '',
                  item.disabled ? 'is-disabled' : '',
                  item.children?.length ? 'has-children' : '',
                  item.keepOpen ? 'keeps-open' : ''
                ].filter(Boolean).join(' ')}
              >
                <path className="controller-radial-segment-shape" d={geometry.path} />
                {selected && <path className="controller-radial-segment-accent" d={geometry.accentPath} />}
                <g
                  className="controller-radial-segment-glyph"
                  transform={`translate(${geometry.iconPoint.x.toFixed(3)} ${geometry.iconPoint.y.toFixed(3)})`}
                >
                  <svg x="-15" y="-15" width="30" height="30" viewBox="0 0 24 24">
                    <RadialGlyph item={item} />
                  </svg>
                  {(item.children?.length || item.keepOpen) && (
                    <text className="controller-radial-segment-marker" x="18" y="5">
                      {item.children?.length ? '>' : '+'}
                    </text>
                  )}
                </g>
              </g>
            )
          })}
          {aimGeometry && (
            <g className="controller-radial-aim">
              <line
                x1={RADIAL_CENTER}
                y1={RADIAL_CENTER}
                x2={aimGeometry.end.x.toFixed(3)}
                y2={aimGeometry.end.y.toFixed(3)}
              />
              <circle cx={aimGeometry.dot.x.toFixed(3)} cy={aimGeometry.dot.y.toFixed(3)} r="5" />
            </g>
          )}
        </svg>
        <div className="controller-radial-center">
          <span>{view.title}</span>
          <strong>{selectedItem?.label ?? ''}</strong>
        </div>
      </div>
      <div className="controller-radial-hints">
        <span>
          <ControllerGlyph family={family} button="activate" /> {selectedHint}
        </span>
        <span>
          <ControllerGlyph family={family} button="back" /> {backLabel}
        </span>
      </div>
    </div>
  )
}
