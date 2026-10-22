import type { CSSProperties } from 'react'

// A brief decorative wave confined to the switch corner, unrelated to telemetry.
function patchNoise(column: number, row: number): number {
  let value = Math.imul(column + 1, 374761393) ^ Math.imul(row + 1, 668265263)
  value = Math.imul(value ^ (value >>> 13), 1274126177)
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296
}

// Stop the wave's spread; already-started blocks finish at their normal strength.
const tiles = Array.from({ length: 15 * 8 }, (_, index) => {
  const column = index % 15, row = Math.floor(index / 15)
  const cluster = patchNoise(Math.floor(column / 3), Math.floor(row / 2))
  const noise = patchNoise(column, row)
  const distance = Math.hypot((14 - column) / 14, row / 12)
  return { x: column * 24, y: row * 12, original: cluster > .63,
    delay: distance * 350 + noise * 110,
    strength: .24 + cluster * .25 }
}).filter(tile => tile.delay <= 275)

export default function StratumEnableWave() {
  return <svg className="servers-stratum-wave" aria-hidden="true" viewBox="0 0 360 96" preserveAspectRatio="none">
    {tiles.map((tile, index) => <rect key={index} x={tile.x} y={tile.y}
      width={24} height={12} className={tile.original ? 'is-original' : undefined}
      style={{ '--wave-delay': `${tile.delay}ms`, '--wave-strength': tile.strength } as CSSProperties} />)}
  </svg>
}
