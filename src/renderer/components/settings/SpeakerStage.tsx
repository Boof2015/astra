import { useCallback, useMemo, useRef } from 'react'
import {
  azimuthDegToStagePosition,
  clampAzimuthToMinSeparation,
  pointerToAzimuthDeg,
  snapAzimuthDeg,
} from '../../utils/virtualSpeakerRoomGeometry'

/*
 * Shared top-down speaker stage.
 *
 * Direct mode: a fixed visualization of the physical output layout — pucks
 * sit at conventional positions and clicking one opens its routing editor in
 * the panel below the stage.
 *
 * Binaural mode (Virtual Speaker Room): the same stage with draggable pucks;
 * dragging a speaker around the listener changes its render azimuth live.
 *
 * SVG rather than canvas: at most 9 interactive nodes, and SVG gives
 * hit-testing, focus and theming (CSS variables) for free.
 */

export type SpeakerStagePuckState = 'routed' | 'unused' | 'inactive'

export interface SpeakerStageSpeaker {
  id: string
  /** Short id shown on the puck (FL, FR, ...). */
  channelId: string
  /** Full name for tooltips/aria. */
  label: string
  /** UI degrees clockwise-from-front; null = non-positional (LFE badge). */
  azimuth: number | null
  /**
   * Degrees above (+) / below (-) ear level. Rendered as a caption on the
   * puck plus a top-down radial projection: the puck sits at cos(elevation)
   * of the ring radius, so 45° draws at ~71% and 90° lands on the listener
   * (directly overhead).
   */
  elevation?: number
  state: SpeakerStagePuckState
  draggable?: boolean
}

interface SpeakerStageProps {
  speakers: SpeakerStageSpeaker[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Live angle updates while dragging (already snapped/clamped). */
  onAzimuthChange?: (id: string, azimuthDeg: number) => void
  disabled?: boolean
  disabledTitle?: string
}

const VIEW_WIDTH = 340
const VIEW_HEIGHT = 260
const CENTER_X = VIEW_WIDTH / 2
const CENTER_Y = VIEW_HEIGHT / 2 + 6
const RING_RADIUS = 96
const PUCK_RADIUS = 15
const MIN_SEPARATION_DEG = 4
const DRAG_SNAP_DEG = 1
const DRAG_SNAP_COARSE_DEG = 5
const KEYBOARD_STEP_DEG = 1
const KEYBOARD_STEP_COARSE_DEG = 5

function usageStatusText(state: SpeakerStagePuckState): string {
  switch (state) {
    case 'routed':
      return 'Routed from current track'
    case 'unused':
      return 'Not used by current track'
    case 'inactive':
      return 'Inactive'
  }
}

function puckPosition(azimuthDeg: number, elevationDeg = 0): { x: number; y: number } {
  // Top-down projection: an elevated (or lowered) speaker's floor-plane
  // distance from the listener shrinks by cos(elevation).
  const radius = RING_RADIUS * Math.cos((elevationDeg * Math.PI) / 180)
  const point = azimuthDegToStagePosition(azimuthDeg, radius)
  return { x: CENTER_X + point.x, y: CENTER_Y + point.y }
}

export default function SpeakerStage({
  speakers,
  selectedId,
  onSelect,
  onAzimuthChange,
  disabled = false,
  disabledTitle,
}: SpeakerStageProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragStateRef = useRef<{
    pointerId: number
    speakerId: string
    moved: boolean
    wasSelected: boolean
  } | null>(null)

  const positionalSpeakers = useMemo(
    () => speakers.filter((sp): sp is SpeakerStageSpeaker & { azimuth: number } => sp.azimuth !== null),
    [speakers]
  )
  const lfeSpeakers = useMemo(() => speakers.filter((sp) => sp.azimuth === null), [speakers])

  const resolveDragAzimuth = useCallback(
    (speakerId: string, clientX: number, clientY: number, coarse: boolean): number | null => {
      const svg = svgRef.current
      if (!svg) return null
      const rect = svg.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      // The stage keeps a fixed aspect ratio (CSS aspect-ratio), so the
      // viewBox scales uniformly with no letterboxing.
      const scale = rect.width / VIEW_WIDTH
      const dx = (clientX - rect.left) / scale - CENTER_X
      const dy = (clientY - rect.top) / scale - CENTER_Y
      if (dx === 0 && dy === 0) return null
      const raw = pointerToAzimuthDeg(dx, dy)
      const snapped = snapAzimuthDeg(raw, coarse ? DRAG_SNAP_COARSE_DEG : DRAG_SNAP_DEG)
      const others = positionalSpeakers
        .filter((sp) => sp.id !== speakerId)
        .map((sp) => sp.azimuth)
      return clampAzimuthToMinSeparation(snapped, others, MIN_SEPARATION_DEG)
    },
    [positionalSpeakers]
  )

  const handlePuckPointerDown = (
    event: React.PointerEvent<SVGGElement>,
    speaker: SpeakerStageSpeaker
  ) => {
    event.stopPropagation()
    if (disabled) return
    const wasSelected = selectedId === speaker.id
    if (!speaker.draggable || !onAzimuthChange) {
      // Static pucks toggle like buttons: click again to close the editor.
      onSelect(wasSelected ? null : speaker.id)
      return
    }
    // Draggable pucks select immediately (drag feedback); a clean click on an
    // already-selected puck toggles it off on pointer-up instead.
    onSelect(speaker.id)
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStateRef.current = {
      pointerId: event.pointerId,
      speakerId: speaker.id,
      moved: false,
      wasSelected,
    }
  }

  const handlePuckPointerMove = (
    event: React.PointerEvent<SVGGElement>,
    speaker: SpeakerStageSpeaker
  ) => {
    const drag = dragStateRef.current
    if (!drag || drag.pointerId !== event.pointerId || drag.speakerId !== speaker.id) return
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const azimuth = resolveDragAzimuth(speaker.id, event.clientX, event.clientY, event.shiftKey)
    if (azimuth === null) return
    drag.moved = true
    onAzimuthChange?.(speaker.id, azimuth)
  }

  const handlePuckPointerEnd = (event: React.PointerEvent<SVGGElement>) => {
    const drag = dragStateRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (event.type === 'pointerup' && !drag.moved && drag.wasSelected) {
      onSelect(null)
    }
    dragStateRef.current = null
  }

  const handlePuckKeyDown = (
    event: React.KeyboardEvent<SVGGElement>,
    speaker: SpeakerStageSpeaker
  ) => {
    if (disabled || !speaker.draggable || !onAzimuthChange || speaker.azimuth === null) return
    let delta = 0
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') delta = -1
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') delta = 1
    if (delta === 0) return
    event.preventDefault()
    const step = event.shiftKey ? KEYBOARD_STEP_COARSE_DEG : KEYBOARD_STEP_DEG
    const others = positionalSpeakers.filter((sp) => sp.id !== speaker.id).map((sp) => sp.azimuth)
    onAzimuthChange(
      speaker.id,
      clampAzimuthToMinSeparation(speaker.azimuth + delta * step, others, MIN_SEPARATION_DEG)
    )
  }

  return (
    <div
      className={`speaker-stage ${disabled ? 'disabled' : ''}`}
      title={disabled ? disabledTitle : undefined}
    >
      <svg
        ref={svgRef}
        className="speaker-stage-svg"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="group"
        aria-label="Speaker stage"
      >
        {/* Ring + front marker */}
        <circle
          className="speaker-stage-ring"
          cx={CENTER_X}
          cy={CENTER_Y}
          r={RING_RADIUS}
        />
        <line
          className="speaker-stage-front-tick"
          x1={CENTER_X}
          y1={CENTER_Y - RING_RADIUS - 8}
          x2={CENTER_X}
          y2={CENTER_Y - RING_RADIUS + 6}
        />
        <text className="speaker-stage-front-label" x={CENTER_X} y={CENTER_Y - RING_RADIUS - 14}>
          FRONT
        </text>

        {/* Listener */}
        <g className="speaker-stage-listener" aria-hidden>
          <circle cx={CENTER_X} cy={CENTER_Y} r={11} />
          <path
            d={`M ${CENTER_X - 4} ${CENTER_Y - 9.5} L ${CENTER_X} ${CENTER_Y - 15} L ${CENTER_X + 4} ${CENTER_Y - 9.5}`}
          />
        </g>

        {/* Speaker pucks */}
        {positionalSpeakers.map((speaker) => {
          const { x, y } = puckPosition(speaker.azimuth, speaker.elevation ?? 0)
          const selected = speaker.id === selectedId
          const usageStatus = usageStatusText(speaker.state)
          const elevationDeg = Math.round(speaker.elevation ?? 0)
          const elevationCaption = elevationDeg !== 0
            ? `${elevationDeg > 0 ? '↑' : '↓'}${Math.abs(elevationDeg)}°`
            : null
          const classes = [
            'speaker-stage-puck',
            `state-${speaker.state}`,
            selected ? 'selected' : '',
            speaker.draggable && !disabled ? 'draggable' : '',
          ].filter(Boolean).join(' ')
          return (
            <g
              key={speaker.id}
              className={classes}
              transform={`translate(${x}, ${y})`}
              tabIndex={disabled ? -1 : 0}
              role={speaker.draggable ? 'slider' : 'button'}
              aria-label={
                speaker.draggable
                  ? `${speaker.label} position, ${usageStatus.toLowerCase()}`
                  : `${speaker.label} routing, ${usageStatus.toLowerCase()}`
              }
              aria-valuenow={speaker.draggable ? Math.round(speaker.azimuth) : undefined}
              aria-valuemin={speaker.draggable ? -180 : undefined}
              aria-valuemax={speaker.draggable ? 180 : undefined}
              aria-valuetext={speaker.draggable ? `${Math.round(speaker.azimuth)} degrees` : undefined}
              onPointerDown={(event) => handlePuckPointerDown(event, speaker)}
              onPointerMove={(event) => handlePuckPointerMove(event, speaker)}
              onPointerUp={handlePuckPointerEnd}
              onPointerCancel={handlePuckPointerEnd}
              onKeyDown={(event) => handlePuckKeyDown(event, speaker)}
            >
              <title>
                {`${speaker.label} (${Math.round(speaker.azimuth)}°${elevationCaption ? `, ${elevationDeg}° elevation` : ''}) — ${usageStatus}`}
              </title>
              <circle className="speaker-stage-puck-body" r={PUCK_RADIUS} />
              <text className="speaker-stage-puck-id" dy="0.34em">
                {speaker.channelId}
              </text>
              {elevationCaption && (
                <text className="speaker-stage-puck-elevation" y={PUCK_RADIUS + 9}>
                  {elevationCaption}
                </text>
              )}
            </g>
          )
        })}
      </svg>

      {lfeSpeakers.length > 0 && (
        <div className="speaker-stage-lfe-row">
          {lfeSpeakers.map((speaker) => (
            <button
              key={speaker.id}
              type="button"
              className={`speaker-stage-lfe-badge state-${speaker.state} ${speaker.id === selectedId ? 'selected' : ''}`}
              onClick={() => {
                if (!disabled) onSelect(selectedId === speaker.id ? null : speaker.id)
              }}
              disabled={disabled}
              title={`${speaker.label} (non-positional) — ${usageStatusText(speaker.state)}`}
              aria-label={`${speaker.label}, non-positional, ${usageStatusText(speaker.state).toLowerCase()}`}
            >
              {speaker.channelId}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
