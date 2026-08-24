export type RootTrackColumnId =
  | 'title'
  | 'artist'
  | 'album'
  | 'year'
  | 'genre'
  | 'bpm'
  | 'musical_key'
  | 'rating'
  | 'codec'
  | 'added'
  | 'play_count'
  | 'duration'

export type TrackSortKey = RootTrackColumnId
export type TrackSortDirection = 'asc' | 'desc'

export interface TrackSortRule {
  key: TrackSortKey
  direction: TrackSortDirection
}

export interface RootTrackColumnLayoutEntry {
  id: RootTrackColumnId
  visible: boolean
}

export interface RootTrackTableLayout {
  columns: RootTrackColumnLayoutEntry[]
}

export interface RootTrackTableSeedVisibility {
  showBpmKey?: boolean
  showGenre?: boolean
  showAdded?: boolean
  showPlayCount?: boolean
  showRating?: boolean
}

export interface ResolvedRootTrackColumns {
  visibleColumns: RootTrackColumnLayoutEntry[]
  responsiveHiddenColumns: RootTrackColumnId[]
}

export const ROOT_TRACK_COLUMN_ORDER: readonly RootTrackColumnId[] = [
  'title',
  'artist',
  'album',
  'year',
  'genre',
  'bpm',
  'musical_key',
  'rating',
  'codec',
  'added',
  'play_count',
  'duration'
]

export const ROOT_TRACK_COLUMN_LABELS: Readonly<Record<RootTrackColumnId, string>> = {
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  year: 'Year',
  genre: 'Genre',
  bpm: 'BPM',
  musical_key: 'Key',
  rating: 'Rating',
  codec: 'Codec',
  added: 'Added',
  play_count: 'Plays',
  duration: 'Length'
}

const ROOT_TRACK_SORT_DIRECTION_LABELS: Readonly<Record<RootTrackColumnId, Readonly<Record<TrackSortDirection, string>>>> = {
  title: { asc: 'A–Z', desc: 'Z–A' },
  artist: { asc: 'A–Z', desc: 'Z–A' },
  album: { asc: 'A–Z', desc: 'Z–A' },
  year: { asc: 'Oldest first', desc: 'Newest first' },
  genre: { asc: 'A–Z', desc: 'Z–A' },
  bpm: { asc: 'Lowest first', desc: 'Highest first' },
  musical_key: { asc: 'A–Z', desc: 'Z–A' },
  rating: { asc: 'Lowest first', desc: 'Highest first' },
  codec: { asc: 'A–Z', desc: 'Z–A' },
  added: { asc: 'Oldest first', desc: 'Newest first' },
  play_count: { asc: 'Least played', desc: 'Most played' },
  duration: { asc: 'Shortest first', desc: 'Longest first' }
}

const ROOT_TRACK_COLUMN_REQUIRED_WIDTHS: Readonly<Record<RootTrackColumnId, number>> = {
  title: 160,
  artist: 92,
  album: 104,
  year: 58,
  genre: 82,
  bpm: 54,
  musical_key: 54,
  rating: 88,
  codec: 62,
  added: 72,
  play_count: 54,
  duration: 58
}

const ROOT_TRACK_COLUMN_ID_SET = new Set<string>(ROOT_TRACK_COLUMN_ORDER)

export const DEFAULT_TRACK_SORT_RULES: readonly TrackSortRule[] = [
  { key: 'title', direction: 'asc' }
]

export function isRootTrackColumnId(value: unknown): value is RootTrackColumnId {
  return typeof value === 'string' && ROOT_TRACK_COLUMN_ID_SET.has(value)
}

export function getDefaultTrackSortDirection(key: TrackSortKey): TrackSortDirection {
  return key === 'added' || key === 'play_count' || key === 'rating' || key === 'year' ? 'desc' : 'asc'
}

export function getTrackSortDirectionLabel(key: TrackSortKey, direction: TrackSortDirection): string {
  return ROOT_TRACK_SORT_DIRECTION_LABELS[key][direction]
}

export function replaceTrackSortRulesFromHeader(
  currentRules: readonly TrackSortRule[],
  key: TrackSortKey
): TrackSortRule[] {
  const current = currentRules.length === 1 && currentRules[0]?.key === key
    ? currentRules[0]
    : null
  return [{
    key,
    direction: current
      ? (current.direction === 'asc' ? 'desc' : 'asc')
      : getDefaultTrackSortDirection(key)
  }]
}

export function reorderTrackSortRules(
  rules: readonly TrackSortRule[],
  fromIndex: number,
  toIndex: number
): TrackSortRule[] {
  const normalized = normalizeTrackSortRules(rules)
  if (
    fromIndex === toIndex
    || fromIndex < 0
    || toIndex < 0
    || fromIndex >= normalized.length
    || toIndex >= normalized.length
  ) return normalized
  const next = [...normalized]
  const [rule] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, rule)
  return next
}

function defaultVisibility(id: RootTrackColumnId, seed: RootTrackTableSeedVisibility): boolean {
  if (id === 'title' || id === 'artist' || id === 'album' || id === 'codec' || id === 'duration') return true
  if (id === 'genre') return Boolean(seed.showGenre)
  if (id === 'bpm' || id === 'musical_key') return Boolean(seed.showBpmKey)
  if (id === 'rating') return Boolean(seed.showRating)
  if (id === 'added') return Boolean(seed.showAdded)
  if (id === 'play_count') return Boolean(seed.showPlayCount)
  return false
}

export function createDefaultRootTrackTableLayout(
  seed: RootTrackTableSeedVisibility = {}
): RootTrackTableLayout {
  return {
    columns: ROOT_TRACK_COLUMN_ORDER.map((id) => ({
      id,
      visible: defaultVisibility(id, seed)
    }))
  }
}

export function normalizeRootTrackTableLayout(
  value: unknown,
  seed: RootTrackTableSeedVisibility = {}
): RootTrackTableLayout {
  const defaults = createDefaultRootTrackTableLayout(seed)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults
  const rawColumns = (value as { columns?: unknown }).columns
  if (!Array.isArray(rawColumns)) return defaults

  const byId = new Map<RootTrackColumnId, RootTrackColumnLayoutEntry>()
  for (const rawColumn of rawColumns) {
    if (!rawColumn || typeof rawColumn !== 'object' || Array.isArray(rawColumn)) continue
    const record = rawColumn as Record<string, unknown>
    if (!isRootTrackColumnId(record.id) || byId.has(record.id)) continue
    byId.set(record.id, {
      id: record.id,
      visible: record.id === 'title' ? true : Boolean(record.visible)
    })
  }

  const ordered: RootTrackColumnLayoutEntry[] = []
  const title = byId.get('title') ?? defaults.columns[0]
  ordered.push({ ...title, visible: true })
  byId.delete('title')

  for (const rawColumn of rawColumns) {
    if (!rawColumn || typeof rawColumn !== 'object' || Array.isArray(rawColumn)) continue
    const id = (rawColumn as { id?: unknown }).id
    if (!isRootTrackColumnId(id) || id === 'title') continue
    const entry = byId.get(id)
    if (!entry) continue
    ordered.push(entry)
    byId.delete(id)
  }

  for (const fallback of defaults.columns) {
    if (fallback.id === 'title' || ordered.some((entry) => entry.id === fallback.id)) continue
    ordered.push(fallback)
  }

  return { columns: ordered }
}

export function normalizeTrackSortRules(
  value: unknown,
  options: { visibleColumns?: ReadonlySet<RootTrackColumnId>; ratingsEnabled?: boolean } = {}
): TrackSortRule[] {
  const rawRules = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && !Array.isArray(value)
      ? [value]
      : []
  const seen = new Set<RootTrackColumnId>()
  const rules: TrackSortRule[] = []

  for (const rawRule of rawRules) {
    if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) continue
    const record = rawRule as Record<string, unknown>
    if (!isRootTrackColumnId(record.key) || seen.has(record.key)) continue
    if (record.key === 'rating' && options.ratingsEnabled === false) continue
    if (options.visibleColumns && !options.visibleColumns.has(record.key)) continue
    seen.add(record.key)
    rules.push({ key: record.key, direction: record.direction === 'desc' ? 'desc' : 'asc' })
  }

  return rules.length > 0 ? rules : DEFAULT_TRACK_SORT_RULES.map((rule) => ({ ...rule }))
}

export function getVisibleRootTrackColumnIds(
  layout: RootTrackTableLayout,
  ratingsEnabled = true
): Set<RootTrackColumnId> {
  return new Set(layout.columns
    .filter((entry) => entry.visible && (entry.id !== 'rating' || ratingsEnabled))
    .map((entry) => entry.id))
}

export function resolveRootTrackColumns(
  layout: RootTrackTableLayout,
  availableWidth: number,
  fixedChromeWidth: number,
  ratingsEnabled = true
): ResolvedRootTrackColumns {
  const requested = layout.columns.filter((entry) => (
    entry.visible && (entry.id !== 'rating' || ratingsEnabled)
  ))
  const visible = requested.map((entry) => ({ ...entry }))
  const responsiveHiddenColumns: RootTrackColumnId[] = []
  const usableWidth = Math.max(ROOT_TRACK_COLUMN_REQUIRED_WIDTHS.title, availableWidth - fixedChromeWidth)

  const minimumTotal = () => visible.reduce((sum, entry) => sum + ROOT_TRACK_COLUMN_REQUIRED_WIDTHS[entry.id], 0)
  while (visible.length > 1 && minimumTotal() > usableWidth) {
    const removed = visible.pop()
    if (!removed || removed.id === 'title') break
    responsiveHiddenColumns.unshift(removed.id)
  }

  return { visibleColumns: visible, responsiveHiddenColumns }
}
