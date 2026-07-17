export function buildPlayableOccurrenceIndexes<T>(
  items: readonly T[],
  isPlayable: (item: T) => boolean
): Array<number | null> {
  let playableIndex = 0
  return items.map((item) => {
    if (!isPlayable(item)) return null
    const index = playableIndex
    playableIndex += 1
    return index
  })
}
