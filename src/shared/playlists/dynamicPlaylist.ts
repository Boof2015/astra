import { normalizeTrackRating } from '../ratings/trackRating'

export type PlaylistKind = 'normal' | 'dynamic'

export type DynamicPlaylistTextField =
  | 'title'
  | 'artist'
  | 'album'
  | 'album_artist'
  | 'genre'
  | 'format'
  | 'musical_key'

export type DynamicPlaylistExactField = 'source_type' | 'favorite' | 'rated'
export type DynamicPlaylistNumericField = 'play_count' | 'year' | 'duration_seconds' | 'bpm' | 'rating'
export type DynamicPlaylistDateField = 'last_played_at' | 'added_at'
export type DynamicPlaylistSortField =
  | 'title'
  | 'artist'
  | 'album'
  | 'added_at'
  | 'last_played_at'
  | 'play_count'
  | 'year'
  | 'duration_seconds'
  | 'bpm'
  | 'rating'

export type DynamicPlaylistTextOperator = 'contains' | 'is' | 'is_not'
export type DynamicPlaylistExactOperator = 'is' | 'is_not'
export type DynamicPlaylistNumericOperator = 'eq' | 'gte' | 'lte'
export type DynamicPlaylistLastPlayedOperator = 'never' | 'within_days' | 'not_within_days'
export type DynamicPlaylistAddedAtOperator = 'within_days' | 'older_than_days'
export type DynamicPlaylistSourceType = 'local' | 'subsonic' | 'jellyfin'
export type DynamicPlaylistSortDirection = 'asc' | 'desc'

export interface DynamicPlaylistTextCondition {
  kind: 'text'
  field: DynamicPlaylistTextField
  operator: DynamicPlaylistTextOperator
  value: string
}

export interface DynamicPlaylistSourceCondition {
  kind: 'exact'
  field: 'source_type'
  operator: DynamicPlaylistExactOperator
  value: DynamicPlaylistSourceType
}

export interface DynamicPlaylistFavoriteCondition {
  kind: 'exact'
  field: 'favorite'
  operator: DynamicPlaylistExactOperator
  value: boolean
}

// "rated is false" is the only way to reach unrated tracks: numeric rating
// conditions compare against NULL for tracks without a rating row and never match.
export interface DynamicPlaylistRatedCondition {
  kind: 'exact'
  field: 'rated'
  operator: DynamicPlaylistExactOperator
  value: boolean
}

export interface DynamicPlaylistNumericCondition {
  kind: 'numeric'
  field: DynamicPlaylistNumericField
  operator: DynamicPlaylistNumericOperator
  value: number
}

export interface DynamicPlaylistLastPlayedCondition {
  kind: 'date'
  field: 'last_played_at'
  operator: DynamicPlaylistLastPlayedOperator
  value?: number
}

export interface DynamicPlaylistAddedAtCondition {
  kind: 'date'
  field: 'added_at'
  operator: DynamicPlaylistAddedAtOperator
  value: number
}

export type DynamicPlaylistCondition =
  | DynamicPlaylistTextCondition
  | DynamicPlaylistSourceCondition
  | DynamicPlaylistFavoriteCondition
  | DynamicPlaylistRatedCondition
  | DynamicPlaylistNumericCondition
  | DynamicPlaylistLastPlayedCondition
  | DynamicPlaylistAddedAtCondition

export interface DynamicPlaylistSort {
  field: DynamicPlaylistSortField
  direction: DynamicPlaylistSortDirection
}

export interface DynamicPlaylistRulesV1 {
  version: 1
  conditions: DynamicPlaylistCondition[]
  sort: DynamicPlaylistSort
  limit: number | null
}

export const DYNAMIC_PLAYLIST_TEXT_FIELDS: readonly DynamicPlaylistTextField[] = [
  'title',
  'artist',
  'album',
  'album_artist',
  'genre',
  'format',
  'musical_key'
]

export const DYNAMIC_PLAYLIST_NUMERIC_FIELDS: readonly DynamicPlaylistNumericField[] = [
  'play_count',
  'year',
  'duration_seconds',
  'bpm',
  'rating'
]

export const DYNAMIC_PLAYLIST_SORT_FIELDS: readonly DynamicPlaylistSortField[] = [
  'title',
  'artist',
  'album',
  'added_at',
  'last_played_at',
  'play_count',
  'year',
  'duration_seconds',
  'bpm',
  'rating'
]

export const DYNAMIC_PLAYLIST_SOURCE_TYPES: readonly DynamicPlaylistSourceType[] = [
  'local',
  'subsonic',
  'jellyfin'
]

export const DEFAULT_DYNAMIC_PLAYLIST_SORT: DynamicPlaylistSort = {
  field: 'title',
  direction: 'asc'
}

const TEXT_OPERATORS: readonly DynamicPlaylistTextOperator[] = ['contains', 'is', 'is_not']
const EXACT_OPERATORS: readonly DynamicPlaylistExactOperator[] = ['is', 'is_not']
const NUMERIC_OPERATORS: readonly DynamicPlaylistNumericOperator[] = ['eq', 'gte', 'lte']
const LAST_PLAYED_OPERATORS: readonly DynamicPlaylistLastPlayedOperator[] = ['never', 'within_days', 'not_within_days']
const ADDED_AT_OPERATORS: readonly DynamicPlaylistAddedAtOperator[] = ['within_days', 'older_than_days']
const SORT_DIRECTIONS: readonly DynamicPlaylistSortDirection[] = ['asc', 'desc']

export function createDefaultDynamicPlaylistRules(): DynamicPlaylistRulesV1 {
  return {
    version: 1,
    conditions: [],
    sort: { ...DEFAULT_DYNAMIC_PLAYLIST_SORT },
    limit: null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string.`)
  }
  return value
}

function requireArrayMember<T extends string>(value: unknown, allowed: readonly T[], fieldName: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T
  }
  throw new Error(`${fieldName} is not supported.`)
}

function normalizePositiveNumber(value: unknown, fieldName: string): number {
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw new Error(`${fieldName} must be a positive number.`)
  }
  return numberValue
}

function normalizePositiveInteger(value: unknown, fieldName: string): number {
  const numberValue = normalizePositiveNumber(value, fieldName)
  if (numberValue < 1) {
    throw new Error(`${fieldName} must be a positive number.`)
  }
  return Math.trunc(numberValue)
}

function normalizeNumericValue(value: unknown, fieldName: DynamicPlaylistNumericField): number {
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numberValue)) {
    throw new Error(`${fieldName} must be a number.`)
  }
  if (fieldName === 'year') return Math.trunc(numberValue)
  if (fieldName === 'rating') {
    const rating = normalizeTrackRating(numberValue)
    if (rating === null) {
      throw new Error('Rating must be between 0.5 and 5.')
    }
    return rating
  }
  return numberValue
}

function normalizeTextCondition(condition: Record<string, unknown>): DynamicPlaylistTextCondition {
  const field = requireArrayMember(condition.field, DYNAMIC_PLAYLIST_TEXT_FIELDS, 'Text field')
  const operator = requireArrayMember(condition.operator, TEXT_OPERATORS, 'Text operator')
  const value = requireString(condition.value, 'Text value').trim()
  if (!value) {
    throw new Error('Text value is required.')
  }
  return { kind: 'text', field, operator, value }
}

function normalizeExactCondition(condition: Record<string, unknown>): DynamicPlaylistSourceCondition | DynamicPlaylistFavoriteCondition | DynamicPlaylistRatedCondition {
  const field = requireArrayMember(condition.field, ['source_type', 'favorite', 'rated'] as const, 'Exact field')
  const operator = requireArrayMember(condition.operator, EXACT_OPERATORS, 'Exact operator')

  if (field === 'source_type') {
    const value = requireArrayMember(condition.value, DYNAMIC_PLAYLIST_SOURCE_TYPES, 'Source type')
    return { kind: 'exact', field, operator, value }
  }

  if (typeof condition.value !== 'boolean') {
    throw new Error(`${field === 'rated' ? 'Rated' : 'Favorite'} value must be true or false.`)
  }
  return { kind: 'exact', field, operator, value: condition.value }
}

function normalizeNumericCondition(condition: Record<string, unknown>): DynamicPlaylistNumericCondition {
  const field = requireArrayMember(condition.field, DYNAMIC_PLAYLIST_NUMERIC_FIELDS, 'Numeric field')
  const operator = requireArrayMember(condition.operator, NUMERIC_OPERATORS, 'Numeric operator')
  const value = normalizeNumericValue(condition.value, field)
  return { kind: 'numeric', field, operator, value }
}

function normalizeDateCondition(condition: Record<string, unknown>): DynamicPlaylistLastPlayedCondition | DynamicPlaylistAddedAtCondition {
  const field = requireArrayMember(condition.field, ['last_played_at', 'added_at'] as const, 'Date field')

  if (field === 'last_played_at') {
    const operator = requireArrayMember(condition.operator, LAST_PLAYED_OPERATORS, 'Last played operator')
    if (operator === 'never') {
      return { kind: 'date', field, operator }
    }
    return {
      kind: 'date',
      field,
      operator,
      value: normalizePositiveNumber(condition.value, 'Day value')
    }
  }

  const operator = requireArrayMember(condition.operator, ADDED_AT_OPERATORS, 'Added date operator')
  return {
    kind: 'date',
    field,
    operator,
    value: normalizePositiveNumber(condition.value, 'Day value')
  }
}

export function normalizeDynamicPlaylistCondition(value: unknown): DynamicPlaylistCondition {
  if (!isRecord(value)) {
    throw new Error('Dynamic playlist condition must be an object.')
  }

  const kind = requireArrayMember(value.kind, ['text', 'exact', 'numeric', 'date'] as const, 'Condition kind')
  if (kind === 'text') return normalizeTextCondition(value)
  if (kind === 'exact') return normalizeExactCondition(value)
  if (kind === 'numeric') return normalizeNumericCondition(value)
  return normalizeDateCondition(value)
}

export function normalizeDynamicPlaylistSort(value: unknown): DynamicPlaylistSort {
  if (!isRecord(value)) return { ...DEFAULT_DYNAMIC_PLAYLIST_SORT }
  return {
    field: requireArrayMember(value.field, DYNAMIC_PLAYLIST_SORT_FIELDS, 'Sort field'),
    direction: requireArrayMember(value.direction, SORT_DIRECTIONS, 'Sort direction')
  }
}

export function normalizeDynamicPlaylistRules(value: unknown): DynamicPlaylistRulesV1 {
  if (!isRecord(value)) {
    throw new Error('Dynamic playlist rules must be an object.')
  }
  if (value.version !== 1) {
    throw new Error('Dynamic playlist rule version is not supported.')
  }

  const rawConditions = Array.isArray(value.conditions) ? value.conditions : []
  const limit = value.limit === null || typeof value.limit === 'undefined'
    ? null
    : normalizePositiveInteger(value.limit, 'Result limit')
  if (limit !== null && limit > 5000) {
    throw new Error('Result limit must be 5000 or less.')
  }

  return {
    version: 1,
    conditions: rawConditions.map(normalizeDynamicPlaylistCondition),
    sort: normalizeDynamicPlaylistSort(value.sort),
    limit
  }
}
