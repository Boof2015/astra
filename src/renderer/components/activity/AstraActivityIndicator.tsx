import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  ASTRA_ACTIVITY_EVENT_DURATIONS_MS,
  type AstraActivityEvent,
  type AstraActivityState,
} from '../../utils/astraActivity'

export interface AstraActivityPulse {
  id: number
  kind: AstraActivityEvent
}

interface AstraActivityIndicatorProps {
  state: AstraActivityState
  event?: AstraActivityPulse | null
  className?: string
  size?: number
}

const COORDS = Array.from({ length: 25 }, (_, index) => {
  const row = Math.floor(index / 5)
  const column = index % 5
  return { cx: 6 + column * 11, cy: 6 + row * 11 }
})

const VIEWBOX = 56
const LIT_DOT = 6.2
const BASE_DOT = 4.8

function uniform(): number[] {
  return Array(25).fill(0)
}

function idleBreath(): number[] {
  const out = Array(25).fill(-1)
  out[12] = 0
  out[7] = 520
  out[11] = 620
  out[13] = 620
  out[17] = 720
  out[6] = 960
  out[8] = 960
  out[16] = 1080
  out[18] = 1080
  out[2] = 1320
  out[10] = 1460
  out[14] = 1460
  out[22] = 1600
  return out
}

function rain(): number[] {
  const out: number[] = []
  const phase = [0, 800, 1500, 400, 1900]
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      out.push(phase[column] + row * 300)
    }
  }
  return out
}

function readingOrder(durationMs = 3000, reverse = false): number[] {
  const out: number[] = []
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      const index = row * 5 + column
      out.push((reverse ? (24 - index) : index) * (durationMs / 25))
    }
  }
  return out
}

function columnBlock(durationMs = 2800): number[] {
  const out: number[] = []
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      out.push(column * (durationMs / 5))
    }
  }
  return out
}

function sonar(durationMs = 1800): number[] {
  const out: number[] = []
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      const distance = Math.max(Math.abs(row - 2), Math.abs(column - 2))
      out.push(distance * (durationMs / 4))
    }
  }
  return out
}

function orbit(durationMs = 1500): number[] {
  const ring = [
    [0, 0], [0, 1], [0, 2], [0, 3], [0, 4],
    [1, 4], [2, 4], [3, 4], [4, 4], [4, 3],
    [4, 2], [4, 1], [4, 0], [3, 0], [2, 0], [1, 0],
  ]
  const out = Array(25).fill(-1)
  for (let index = 0; index < ring.length; index += 1) {
    const [row, column] = ring[index]
    out[row * 5 + column] = index * (durationMs / ring.length)
  }
  return out
}

function bitDecode(): number[] {
  return [
    3280, 2920, 2540, 3140, 3540,
    2760, 1680, 520, 1940, 3020,
    2320, 760, 0, 1120, 2680,
    3360, 2160, 1440, 2460, 3620,
    3920, 3480, 2860, 3760, 4040,
  ]
}

function parallaxConnected(): number[] {
  const out = Array(25).fill(-1)

  // Four diagonal trails resolve into the perimeter of the centered 3x3 square.
  for (const index of [0, 4, 20, 24]) out[index] = 0
  for (const index of [6, 8, 16, 18]) out[index] = 320
  for (const index of [7, 11, 13, 17]) out[index] = 650

  return out
}

function metaFill(): number[] {
  const out: number[] = []
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      out.push(column * 130)
    }
  }
  return out
}

interface IndicatorPattern {
  delays: number[]
  extra?: number[]
}

const IDLE_PATTERN: IndicatorPattern = { delays: idleBreath() }

const STATE_PATTERNS: Record<AstraActivityState, IndicatorPattern> = {
  idle: IDLE_PATTERN,
  playing: { delays: bitDecode() },
  paused: IDLE_PATTERN,
  'loading-track': { delays: orbit(1500) },
  'library-scan': { delays: readingOrder(3000, false) },
  'remote-streaming': { delays: rain() },
  'remote-sync': { delays: readingOrder(3000, false), extra: readingOrder(3000, true) },
  'integrity-scan': { delays: columnBlock(2800) },
  'lyrics-lookup': { delays: sonar(1800) },
  'parallax-connected': { delays: parallaxConnected() },
}

const EVENT_PATTERNS: Record<AstraActivityEvent, number[]> = {
  'metadata-saving': metaFill(),
  'external-connected': uniform(),
  attention: uniform(),
}

function LightDots({ delays }: { delays: number[] }) {
  return (
    <>
      {delays.map((delay, index) => {
        if (delay < 0) return null
        const { cx, cy } = COORDS[index]
        return (
          <circle
            key={`${index}-${delay}`}
            cx={cx}
            cy={cy}
            r={LIT_DOT / 2}
            className="astra-activity-indicator-light"
            style={{ animationDelay: `${delay}ms` }}
          />
        )
      })}
    </>
  )
}

function BaseGrid() {
  return (
    <svg
      className="astra-activity-indicator-base-grid"
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {COORDS.map(({ cx, cy }, index) => (
        <circle
          key={`base-${index}`}
          cx={cx}
          cy={cy}
          r={BASE_DOT / 2}
          className="astra-activity-indicator-base"
        />
      ))}
    </svg>
  )
}

function StateDots({ pattern }: { pattern: IndicatorPattern }) {
  return (
    <svg
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <LightDots delays={pattern.delays} />
      {pattern.extra && <LightDots delays={pattern.extra} />}
    </svg>
  )
}

function EventDots({ event }: { event: AstraActivityEvent }) {
  return (
    <svg
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <LightDots delays={EVENT_PATTERNS[event]} />
    </svg>
  )
}

function AstraActivityIndicatorImpl({
  state,
  event,
  className = '',
  size = 22,
}: AstraActivityIndicatorProps) {
  const [eventActive, setEventActive] = useState(false)
  const [overlayPlaying, setOverlayPlaying] = useState(false)
  const [currentEvent, setCurrentEvent] = useState<AstraActivityEvent | null>(null)
  const [currentEventId, setCurrentEventId] = useState<number | null>(null)
  const frameRef = useRef<number | null>(null)
  const eventEndTimerRef = useRef<number | null>(null)
  const resumeTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!event) return

    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    if (eventEndTimerRef.current !== null) {
      window.clearTimeout(eventEndTimerRef.current)
      eventEndTimerRef.current = null
    }
    if (resumeTimerRef.current !== null) {
      window.clearTimeout(resumeTimerRef.current)
      resumeTimerRef.current = null
    }

    setCurrentEvent(event.kind)
    setCurrentEventId(event.id)
    setEventActive(true)
    setOverlayPlaying(false)

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      setOverlayPlaying(true)
    })

    eventEndTimerRef.current = window.setTimeout(() => {
      setOverlayPlaying(false)
      eventEndTimerRef.current = null

      resumeTimerRef.current = window.setTimeout(() => {
        setEventActive(false)
        setCurrentEvent(null)
        setCurrentEventId(null)
        resumeTimerRef.current = null
      }, 220)
    }, ASTRA_ACTIVITY_EVENT_DURATIONS_MS[event.kind])
  }, [event?.id, event?.kind])

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
      if (eventEndTimerRef.current !== null) window.clearTimeout(eventEndTimerRef.current)
      if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current)
    }
  }, [])

  const rootClassName = [
    'astra-activity-indicator',
    eventActive ? 'is-event-active' : '',
    className,
  ].filter(Boolean).join(' ')
  const rootStyle = { '--astra-activity-indicator-size': `${size}px` } as CSSProperties
  const statePattern = STATE_PATTERNS[state]

  return (
    <span className={rootClassName} style={rootStyle} aria-hidden="true">
      <BaseGrid />
      <span
        key={state}
        className={`astra-activity-indicator-layer astra-activity-indicator-state-${state} is-on`}
        data-state={state}
      >
        <StateDots pattern={statePattern} />
      </span>
      <span
        className={`astra-activity-indicator-overlay ${overlayPlaying ? 'is-playing' : ''}`.trim()}
        data-event={currentEvent ?? undefined}
      >
        {currentEvent && currentEventId !== null && (
          <EventDots key={`${currentEvent}-${currentEventId}`} event={currentEvent} />
        )}
      </span>
    </span>
  )
}

export default memo(AstraActivityIndicatorImpl)
