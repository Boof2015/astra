const WORD_BOUNDARY_SEPARATORS = new Set([' ', '\t', '-', '_', '/', '.', ',', ':', ';', '(', ')', '[', ']', '{', '}', '"', '\''])
const WHITESPACE_PATTERN = /\s/u
const COMBINING_MARK_PATTERN = /\p{M}/gu

const MATCH_KIND_RANK = {
  compact: 1,
  initialism: 2,
  substring: 3,
  'word-prefix': 4,
  prefix: 5,
  exact: 6
} as const

const MATCH_KIND_SCORE_SCALE = 1_000_000_000
const FIELD_WEIGHT_SCORE_SCALE = 1_000_000
const MAX_FIELD_WEIGHT_RANK = 999
const MAX_PROXIMITY_COMPONENT = 99

export type FuzzyMatchKind = keyof typeof MATCH_KIND_RANK

export interface FuzzyMatch {
  kind: FuzzyMatchKind
  score: number
  indices: number[]
  span: number
  startIndex: number
}

interface NormalizedSearchValue {
  value: string
  originalIndices: number[]
}

interface DetailedFuzzyMatch {
  kind: FuzzyMatchKind
  score: number
  normalizedIndices: number[]
  span: number
  startIndex: number
  normalizedCandidateLength: number
  normalizedQueryLength: number
}

function normalizeSearchValueWithIndices(value: string): NormalizedSearchValue {
  let normalized = ''
  const originalIndices: number[] = []
  let pendingWhitespaceIndex = -1

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (WHITESPACE_PATTERN.test(character)) {
      if (normalized.length > 0 && pendingWhitespaceIndex < 0) {
        pendingWhitespaceIndex = index
      }
      continue
    }

    if (pendingWhitespaceIndex >= 0) {
      normalized += ' '
      originalIndices.push(pendingWhitespaceIndex)
      pendingWhitespaceIndex = -1
    }

    const lowerCharacter = character
      .normalize('NFD')
      .replace(COMBINING_MARK_PATTERN, '')
      .toLocaleLowerCase()
    normalized += lowerCharacter
    for (let lowerIndex = 0; lowerIndex < lowerCharacter.length; lowerIndex += 1) {
      originalIndices.push(index)
    }
  }

  return { value: normalized, originalIndices }
}

function normalizeSearchValue(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARK_PATTERN, '')
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
}

function isWordBoundary(value: string, index: number): boolean {
  if (index <= 0) return true
  return WORD_BOUNDARY_SEPARATORS.has(value[index - 1])
}

function isWordStart(value: string, index: number): boolean {
  return !WORD_BOUNDARY_SEPARATORS.has(value[index]) && isWordBoundary(value, index)
}

function isSingleToken(value: string): boolean {
  for (const character of value) {
    if (WORD_BOUNDARY_SEPARATORS.has(character)) return false
  }
  return true
}

function buildRange(start: number, length: number): number[] {
  return Array.from({ length }, (_, offset) => start + offset)
}

function proximityScore(
  normalizedQueryLength: number,
  normalizedCandidateLength: number,
  startIndex: number,
  span: number
): number {
  const compactnessRank = MAX_PROXIMITY_COMPONENT - Math.min(
    MAX_PROXIMITY_COMPONENT,
    Math.max(0, span - normalizedQueryLength)
  )
  const startRank = MAX_PROXIMITY_COMPONENT - Math.min(
    MAX_PROXIMITY_COMPONENT,
    Math.max(0, startIndex)
  )
  const lengthRank = MAX_PROXIMITY_COMPONENT - Math.min(
    MAX_PROXIMITY_COMPONENT,
    Math.max(0, normalizedCandidateLength - normalizedQueryLength)
  )

  return (compactnessRank * 10_000) + (startRank * 100) + lengthRank
}

function createMatch(
  kind: FuzzyMatchKind,
  normalizedIndices: number[],
  normalizedCandidate: string,
  normalizedQueryLength: number
): DetailedFuzzyMatch {
  const startIndex = normalizedIndices[0]
  const endIndex = normalizedIndices[normalizedIndices.length - 1]
  const span = endIndex - startIndex + 1
  const score = (MATCH_KIND_RANK[kind] * MATCH_KIND_SCORE_SCALE) + proximityScore(
    normalizedQueryLength,
    normalizedCandidate.length,
    startIndex,
    span
  )

  return {
    kind,
    score,
    normalizedIndices,
    span,
    startIndex,
    normalizedCandidateLength: normalizedCandidate.length,
    normalizedQueryLength
  }
}

function findConsecutiveInitials(query: string, candidate: string): number[] | null {
  const wordStarts: number[] = []
  for (let index = 0; index < candidate.length; index += 1) {
    if (isWordStart(candidate, index)) wordStarts.push(index)
  }

  for (let start = 0; start <= wordStarts.length - query.length; start += 1) {
    const indices = wordStarts.slice(start, start + query.length)
    if (indices.every((candidateIndex, queryIndex) => candidate[candidateIndex] === query[queryIndex])) {
      return indices
    }
  }

  return null
}

function findCompactSubsequence(query: string, candidate: string): number[] | null {
  const maximumSpan = query.length * 2
  let bestIndices: number[] | null = null

  for (let startIndex = 0; startIndex < candidate.length; startIndex += 1) {
    if (candidate[startIndex] !== query[0] || !isWordStart(candidate, startIndex)) continue

    const indices = [startIndex]
    let queryIndex = 1
    const endExclusive = Math.min(candidate.length, startIndex + maximumSpan)

    for (let candidateIndex = startIndex + 1; candidateIndex < endExclusive; candidateIndex += 1) {
      if (candidate[candidateIndex] !== query[queryIndex]) continue
      indices.push(candidateIndex)
      queryIndex += 1
      if (queryIndex === query.length) break
    }

    if (queryIndex !== query.length) continue
    if (!bestIndices) {
      bestIndices = indices
      continue
    }

    const span = indices[indices.length - 1] - indices[0] + 1
    const bestSpan = bestIndices[bestIndices.length - 1] - bestIndices[0] + 1
    if (span < bestSpan || (span === bestSpan && indices[0] < bestIndices[0])) {
      bestIndices = indices
    }
  }

  return bestIndices
}

function findNormalizedFuzzyMatch(query: string, candidate: string): DetailedFuzzyMatch | null {
  if (!query || !candidate) return null

  if (candidate === query) {
    return createMatch('exact', buildRange(0, query.length), candidate, query.length)
  }

  if (candidate.startsWith(query)) {
    return createMatch('prefix', buildRange(0, query.length), candidate, query.length)
  }

  for (let index = 1; index <= candidate.length - query.length; index += 1) {
    if (!isWordStart(candidate, index) || !candidate.startsWith(query, index)) continue
    return createMatch('word-prefix', buildRange(index, query.length), candidate, query.length)
  }

  if (query.length >= 3) {
    const substringIndex = candidate.indexOf(query)
    if (substringIndex >= 0) {
      return createMatch('substring', buildRange(substringIndex, query.length), candidate, query.length)
    }
  }

  if (!isSingleToken(query)) return null

  if (query.length >= 2) {
    const initialIndices = findConsecutiveInitials(query, candidate)
    if (initialIndices) {
      return createMatch('initialism', initialIndices, candidate, query.length)
    }
  }

  if (query.length >= 3) {
    const compactIndices = findCompactSubsequence(query, candidate)
    if (compactIndices) {
      return createMatch('compact', compactIndices, candidate, query.length)
    }
  }

  return null
}

function findDetailedFuzzyMatch(queryInput: string, candidateInput: string): DetailedFuzzyMatch | null {
  return findNormalizedFuzzyMatch(
    normalizeSearchValue(queryInput),
    normalizeSearchValue(candidateInput)
  )
}

export function findFuzzyMatch(queryInput: string, candidateInput: string): FuzzyMatch | null {
  const query = normalizeSearchValue(queryInput)
  const candidate = normalizeSearchValueWithIndices(candidateInput)
  const match = findNormalizedFuzzyMatch(query, candidate.value)
  if (!match) return null
  const indices = match.normalizedIndices
    .map((index) => candidate.originalIndices[index])
    .filter((index, position, values) => position === 0 || index !== values[position - 1])
  return {
    kind: match.kind,
    score: match.score,
    indices,
    span: match.span,
    startIndex: match.startIndex
  }
}

export function fuzzyScore(queryInput: string, candidateInput: string): number | null {
  return findDetailedFuzzyMatch(queryInput, candidateInput)?.score ?? null
}

export interface FieldDef {
  value: string
  weight: number
}

function weightedMatchScore(match: DetailedFuzzyMatch, weight: number): number {
  const weightRank = Number.isFinite(weight)
    ? Math.max(0, Math.min(MAX_FIELD_WEIGHT_RANK, Math.round(weight * 100)))
    : 0
  const baseKindScore = MATCH_KIND_RANK[match.kind] * MATCH_KIND_SCORE_SCALE
  const proximity = proximityScore(
    match.normalizedQueryLength,
    match.normalizedCandidateLength,
    match.startIndex,
    match.span
  )
  return baseKindScore + (weightRank * FIELD_WEIGHT_SCORE_SCALE) + proximity
}

export function multiFieldScore(
  queryInput: string,
  fields: FieldDef[]
): number | null {
  const normalizedQuery = normalizeSearchValue(queryInput)
  if (!normalizedQuery) return null

  let bestScore: number | null = null

  for (const field of fields) {
    const match = findNormalizedFuzzyMatch(normalizedQuery, normalizeSearchValue(field.value))
    if (!match) continue
    const fieldScore = weightedMatchScore(match, field.weight)
    if (bestScore === null || fieldScore > bestScore) {
      bestScore = fieldScore
    }
  }

  return bestScore
}

export function getFuzzyFieldScore(
  queryInput: string,
  fields: FieldDef[]
): number | null {
  return multiFieldScore(queryInput, fields)
}

export function matchesFuzzyFields(
  queryInput: string,
  fields: FieldDef[]
): boolean {
  return getFuzzyFieldScore(queryInput, fields) !== null
}

export function rankFuzzyMatches<T>(
  items: readonly T[],
  queryInput: string,
  getFields: (item: T) => FieldDef[]
): T[] {
  if (!normalizeSearchValue(queryInput)) return [...items]

  const scored: Array<{ item: T; score: number; index: number }> = []

  items.forEach((item, index) => {
    const score = getFuzzyFieldScore(queryInput, getFields(item))
    if (score === null) return
    scored.push({ item, score, index })
  })

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    return a.index - b.index
  })

  return scored.map(({ item }) => item)
}
