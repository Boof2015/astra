export interface HomeShelfLimits {
  jumpBackIn: number
  rediscover: number
  newlyAdded: number
  recentTracks: number
}

export function resolveHomeShelfLimits(contentWidth: number): HomeShelfLimits {
  const width = Number.isFinite(contentWidth) ? Math.max(0, contentWidth) : 0
  return {
    jumpBackIn: Math.min(14, Math.max(6, Math.ceil(width / 270))),
    rediscover: Math.min(20, Math.max(8, Math.ceil(width / 200) + 1)),
    newlyAdded: Math.min(20, Math.max(8, Math.ceil(width / 200) + 1)),
    recentTracks: Math.min(20, Math.max(10, Math.ceil(width / 182) + 1))
  }
}
