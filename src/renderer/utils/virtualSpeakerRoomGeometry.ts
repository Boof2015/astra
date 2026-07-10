/*
 * Pure geometry for the speaker stage / Virtual Speaker Room.
 *
 * Stage coordinates: the listener sits at the origin looking "up" (negative
 * y). Azimuth is UI degrees, clockwise-from-front (matches
 * virtualSpeakerLayout.ts), so FR (+30°) lands to the upper right.
 */

export interface StagePoint {
  x: number
  y: number
}

/** Normalizes any angle to (-180, 180]. */
export function normalizeAzimuthDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0
  let normalized = deg % 360
  if (normalized > 180) normalized -= 360
  if (normalized <= -180) normalized += 360
  return normalized
}

/** Ring position (relative to the listener) for an azimuth. */
export function azimuthDegToStagePosition(azimuthDeg: number, radius: number): StagePoint {
  const rad = (normalizeAzimuthDeg(azimuthDeg) * Math.PI) / 180
  return {
    x: Math.sin(rad) * radius,
    y: -Math.cos(rad) * radius,
  }
}

/** Azimuth for a pointer offset from the listener (inverse of the above). */
export function pointerToAzimuthDeg(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0
  return normalizeAzimuthDeg((Math.atan2(dx, -dy) * 180) / Math.PI)
}

export function snapAzimuthDeg(deg: number, stepDeg: number): number {
  const step = Math.max(0.1, Math.abs(stepDeg))
  return normalizeAzimuthDeg(Math.round(normalizeAzimuthDeg(deg) / step) * step)
}

/** Signed shortest angular distance from `from` to `to`, in (-180, 180]. */
export function circularDistanceDeg(from: number, to: number): number {
  return normalizeAzimuthDeg(to - from)
}

/**
 * Keeps a proposed azimuth at least `minSeparationDeg` away from every angle
 * in `others` by nudging it out of the nearest conflict. A couple of passes
 * settle chains of adjacent speakers.
 */
export function clampAzimuthToMinSeparation(
  proposedDeg: number,
  others: readonly number[],
  minSeparationDeg: number
): number {
  const minSep = Math.max(0, minSeparationDeg)
  if (minSep === 0 || others.length === 0) return normalizeAzimuthDeg(proposedDeg)

  let candidate = normalizeAzimuthDeg(proposedDeg)
  for (let pass = 0; pass < 4; pass++) {
    let conflict: number | null = null
    let conflictDistance = Number.POSITIVE_INFINITY
    for (const other of others) {
      const distance = circularDistanceDeg(other, candidate)
      if (Math.abs(distance) < minSep && Math.abs(distance) < Math.abs(conflictDistance)) {
        conflict = other
        conflictDistance = distance
      }
    }
    if (conflict === null) return candidate
    const direction = conflictDistance === 0 ? 1 : Math.sign(conflictDistance)
    candidate = normalizeAzimuthDeg(conflict + direction * minSep)
  }
  return candidate
}
