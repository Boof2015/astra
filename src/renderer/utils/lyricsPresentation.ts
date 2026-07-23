import type { Track } from '../types/audio'
import type {
  LyricsFormat,
  LyricsLine,
  LyricsLookupResult,
  LyricsPayload,
  LyricsSource,
  LyricsTrackQuery,
  LyricsTranslation,
  LyricsWord
} from '../../types/lyrics'

export interface LyricsBodyCopy {
  noTrackMessage: string
  loadingMessage: string
  idleMessage: string
  noReadableTextMessage: string
  onlineDisabledMessage: string
  providerNotFoundMessage: string
  providerUnavailableMessage: string
  embeddedMissingMessage: string
}

export interface ResolveLyricsBodyStateOptions {
  currentTrack: Track | { path: string } | null
  activeLyricsResult: LyricsLookupResult | null
  isLoading: boolean
  errorMessage: string
  copy: LyricsBodyCopy
}

export type LyricsBodyState =
  | { kind: 'no-track'; message: string }
  | { kind: 'loading'; message: string }
  | { kind: 'transient_error'; message: string }
  | { kind: 'not_found'; message: string; reason: 'embedded-missing' | 'online-disabled' | 'provider-not-found' | 'provider-unavailable' }
  | { kind: 'hit_synced'; sourceLabel: string; cached: boolean; syncedLines: LyricsLine[] }
  | { kind: 'hit_plain'; sourceLabel: string; cached: boolean; plainLyrics: string }
  | { kind: 'hit_empty'; message: string; sourceLabel: string; cached: boolean }
  | { kind: 'idle'; message: string }

export const DEFAULT_LYRICS_BODY_COPY: LyricsBodyCopy = {
  noTrackMessage: 'No track selected.',
  loadingMessage: 'Loading lyrics...',
  idleMessage: 'Lyrics are ready when a track is selected.',
  noReadableTextMessage: 'Lyrics were found, but no readable text is available.',
  onlineDisabledMessage: 'No local or embedded lyrics found. Enable Online Lyrics Lookup in Settings to fetch from XLRCDB or LRCLIB.',
  providerNotFoundMessage: 'No lyrics found on XLRCDB or LRCLIB for this track.',
  providerUnavailableMessage: "Lyrics providers didn't respond in time. A retry may work.",
  embeddedMissingMessage: 'No local or embedded lyrics found for this track.'
}

export const INFO_SIDEBAR_LYRICS_BODY_COPY: LyricsBodyCopy = {
  ...DEFAULT_LYRICS_BODY_COPY,
  idleMessage: 'Open the Lyrics tab to load lyrics for the current track.'
}

export function getLyricsSourceLabel(source: LyricsSource, format?: LyricsFormat): string {
  if (source === 'embedded') return 'Embedded'
  if (source === 'manual') return format === 'xlrc' ? 'Manual XLRC' : 'Manual'
  if (source === 'xlrc') return 'XLRC File'
  if (source === 'lrc') return 'LRC File'
  if (source === 'xlrcdb') return 'XLRCDB'
  return 'LRCLIB'
}

export function getLyricsPayloadSourceLabel(payload: LyricsPayload): string {
  return getLyricsSourceLabel(payload.source, payload.format)
}

export function buildLyricsQuery(track: Track | null): LyricsTrackQuery | null {
  if (!track) return null
  return {
    path: track.path,
    title: track.title,
    artist: track.artist,
    album: track.album || undefined,
    durationSeconds: Number.isFinite(track.duration) ? track.duration : undefined
  }
}

export function getLyricsRequestKey(query: LyricsTrackQuery | null): string {
  if (!query) return '__none__'
  return `${query.path}\u0000${query.title}\u0000${query.artist}\u0000${query.album ?? ''}\u0000${query.durationSeconds ?? ''}`
}

export function getActiveLyricsResult(
  currentTrackPath: string | null | undefined,
  lyricsTrackPath: string | null,
  lyricsResult: LyricsLookupResult | null
): LyricsLookupResult | null {
  if (!currentTrackPath) return null
  if (lyricsTrackPath !== currentTrackPath) return null
  return lyricsResult
}

export const LYRICS_INFERRED_GAP_THRESHOLD_MS = 10_000
export const LYRICS_POST_LINE_HOLD_MS = 4_000

export interface RenderableSyncedLine {
  line: LyricsLine
  cueIndex: number
  displayIndex: number
}

export type SyncedLyricsDisplayLine =
  | {
      kind: 'lyric'
      line: LyricsLine
      cueIndex: number
      afterCueIndex: null
      displayIndex: number
      key: string
      timestampMs: number
      text: string
    }
  | {
      kind: 'gap'
      cueIndex: number | null
      afterCueIndex: number | null
      displayIndex: number
      key: string
      timestampMs: number
      text: ''
      progressStartMs: number
      progressEndMs: number | null
    }

export interface SyncedLyricsTimingOptions {
  durationSeconds?: number | null
  neutralGapThresholdMs?: number
  postLineHoldMs?: number
}

export interface SyncedLyricsTimingState {
  activeCueIndex: number
  activeLineIndex: number
  focusLineIndex: number
  isNeutral: boolean
}

function toPlaybackTimeMs(currentTimeSeconds: number): number {
  return Number.isFinite(currentTimeSeconds)
    ? Math.max(0, Math.floor(currentTimeSeconds * 1000))
    : 0
}

function toDurationMs(durationSeconds: number | null | undefined): number | null {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return null
  }
  return Math.floor(durationSeconds * 1000)
}

export function getCompensatedLyricsTime(
  currentTimeSeconds: number,
  durationSeconds: number | null | undefined,
  effectiveDelayMs: number
): number {
  const normalizedTime = Number.isFinite(currentTimeSeconds) ? Math.max(0, currentTimeSeconds) : 0
  const normalizedDelaySeconds = Number.isFinite(effectiveDelayMs)
    ? Math.max(0, effectiveDelayMs) / 1000
    : 0
  const compensatedTime = Math.max(0, normalizedTime - normalizedDelaySeconds)
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return compensatedTime
  }
  return Math.min(durationSeconds, compensatedTime)
}

export function getLyricsLineSeekTimeSeconds(
  timestampMs: number,
  durationSeconds: number | null | undefined,
  effectiveDelayMs: number
): number | null {
  if (!Number.isFinite(timestampMs) || timestampMs < 0) return null

  const normalizedDelaySeconds = Number.isFinite(effectiveDelayMs)
    ? Math.max(0, effectiveDelayMs) / 1000
    : 0
  const seekTimeSeconds = Math.max(0, (timestampMs / 1000) + normalizedDelaySeconds)
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return seekTimeSeconds
  }
  return Math.min(durationSeconds, seekTimeSeconds)
}

export function isRenderableSyncedLine(line: LyricsLine): boolean {
  return line.kind !== 'silence' && line.text.trim().length > 0
}

export function getRenderableSyncedLines(lines: LyricsLine[]): RenderableSyncedLine[] {
  const renderableLines: RenderableSyncedLine[] = []
  lines.forEach((line, cueIndex) => {
    if (!isRenderableSyncedLine(line)) return
    renderableLines.push({
      line,
      cueIndex,
      displayIndex: renderableLines.length
    })
  })
  return renderableLines
}

function findNextRenderableLineTimestamp(lines: LyricsLine[], startIndex: number): number | null {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (isRenderableSyncedLine(lines[index])) return lines[index].timestampMs
  }
  return null
}

export function getSyncedLyricsDisplayLines(
  lines: LyricsLine[],
  options: SyncedLyricsTimingOptions = {}
): SyncedLyricsDisplayLine[] {
  const displayLines: SyncedLyricsDisplayLine[] = []
  const postLineHoldMs = options.postLineHoldMs ?? LYRICS_POST_LINE_HOLD_MS
  const neutralGapThresholdMs = options.neutralGapThresholdMs ?? LYRICS_INFERRED_GAP_THRESHOLD_MS
  const durationMs = toDurationMs(options.durationSeconds)

  lines.forEach((line, cueIndex) => {
    const displayIndex = displayLines.length
    if (isRenderableSyncedLine(line)) {
      displayLines.push({
        kind: 'lyric',
        line,
        cueIndex,
        afterCueIndex: null,
        displayIndex,
        key: `lyric:${line.timestampMs}:${cueIndex}`,
        timestampMs: line.timestampMs,
        text: line.text
      })

      const nextCue = lines[cueIndex + 1] ?? null
      const nextCueGapMs = nextCue ? nextCue.timestampMs - line.timestampMs : null
      const outroGapMs = durationMs === null ? null : durationMs - line.timestampMs
      const shouldInsertGap = (
        nextCueGapMs !== null && nextCueGapMs >= neutralGapThresholdMs
      ) || (
        !nextCue && outroGapMs !== null && outroGapMs >= neutralGapThresholdMs
      )

      if (shouldInsertGap) {
        const gapTimestampMs = line.timestampMs + postLineHoldMs
        const progressEndMs = findNextRenderableLineTimestamp(lines, cueIndex + 1) ?? durationMs
        displayLines.push({
          kind: 'gap',
          cueIndex: null,
          afterCueIndex: cueIndex,
          displayIndex: displayLines.length,
          key: `gap-after:${line.timestampMs}:${cueIndex}`,
          timestampMs: gapTimestampMs,
          text: '',
          progressStartMs: line.timestampMs,
          progressEndMs
        })
      }
      return
    }

    if (line.kind !== 'silence') return
    const progressEndMs = findNextRenderableLineTimestamp(lines, cueIndex + 1) ?? durationMs
    displayLines.push({
      kind: 'gap',
      cueIndex,
      afterCueIndex: null,
      displayIndex,
      key: `gap-cue:${line.timestampMs}:${cueIndex}`,
      timestampMs: line.timestampMs,
      text: '',
      progressStartMs: line.timestampMs,
      progressEndMs
    })
  })

  return displayLines
}

export function getSyncedLyricsGapProgress(
  line: SyncedLyricsDisplayLine,
  currentTimeSeconds: number
): number | null {
  if (line.kind !== 'gap') return null
  if (line.progressEndMs === null || line.progressEndMs <= line.progressStartMs) return null

  const currentTimeMs = toPlaybackTimeMs(currentTimeSeconds)
  const progress = (currentTimeMs - line.progressStartMs) / (line.progressEndMs - line.progressStartMs)
  return Math.max(0, Math.min(1, progress))
}

export function getPreferredLyricsTranslation(
  line: LyricsLine,
  languagePriority: string[]
): LyricsTranslation | null {
  const translations = line.translations ?? []
  if (translations.length === 0) return null

  const normalizedPriority = languagePriority
    .map((lang) => lang.trim().toLocaleLowerCase())
    .filter(Boolean)
  for (const preferredLang of normalizedPriority) {
    const match = translations.find((translation) => translation.lang.toLocaleLowerCase() === preferredLang)
    if (match) return match
  }

  return translations[0] ?? null
}

export interface LyricsLayerSettings {
  wordTimingEnabled: boolean
  furiganaEnabled: boolean
  translationsEnabled: boolean
  translationLanguagePriority: string[]
  voiceLabelsEnabled: boolean
}

export const BASE_COMPACT_LYRICS_LINE_HEIGHT_PX = 34
export const RICH_COMPACT_LYRICS_LINE_HEIGHT_PX = 58
export const DENSE_RICH_COMPACT_LYRICS_LINE_HEIGHT_PX = 62

export function getLyricsWordsForDisplay(
  line: LyricsLine,
  wordTimingEnabled: boolean
): LyricsWord[] {
  if (!wordTimingEnabled) return []
  const words = line.words ?? []
  if (words.length === 0) return []
  return words.map((word) => word.text).join('') === line.text ? words : []
}

function hasUsableFurigana(furigana: LyricsLine['furigana'] | LyricsWord['furigana']): boolean {
  return Boolean(furigana?.some((entry) => (
    entry.reading.trim().length > 0
    && entry.start >= 0
    && entry.end > entry.start
  )))
}

function hasEnabledLyricsFurigana(line: LyricsLine, settings: LyricsLayerSettings): boolean {
  if (!settings.furiganaEnabled) return false
  if (hasUsableFurigana(line.furigana)) return true
  return Boolean(line.words?.some((word) => hasUsableFurigana(word.furigana)))
}

export function getEnabledLyricsLayerState(
  line: LyricsLine,
  settings: LyricsLayerSettings
): {
  hasWordTiming: boolean
  hasFurigana: boolean
  hasTranslation: boolean
  hasVoice: boolean
} {
  const hasWordTiming = getLyricsWordsForDisplay(line, settings.wordTimingEnabled).length > 0
  const hasFurigana = hasEnabledLyricsFurigana(line, settings)
  const hasTranslation = settings.translationsEnabled
    && getPreferredLyricsTranslation(line, settings.translationLanguagePriority) !== null
  const hasVoice = settings.voiceLabelsEnabled && Boolean(line.voice?.trim())

  return {
    hasWordTiming,
    hasFurigana,
    hasTranslation,
    hasVoice
  }
}

export function hasEnabledLyricsLineExtra(line: LyricsLine, settings: LyricsLayerSettings): boolean {
  const layerState = getEnabledLyricsLayerState(line, settings)
  return layerState.hasFurigana || layerState.hasTranslation
}

export function getCompactSyncedLyricsDisplayLineHeight(
  displayLine: SyncedLyricsDisplayLine,
  settings: LyricsLayerSettings
): number {
  if (displayLine.kind !== 'lyric') return BASE_COMPACT_LYRICS_LINE_HEIGHT_PX

  const layerState = getEnabledLyricsLayerState(displayLine.line, settings)
  if (
    (layerState.hasTranslation && layerState.hasFurigana)
  ) {
    return DENSE_RICH_COMPACT_LYRICS_LINE_HEIGHT_PX
  }
  if (layerState.hasTranslation || layerState.hasFurigana) {
    return RICH_COMPACT_LYRICS_LINE_HEIGHT_PX
  }

  return BASE_COMPACT_LYRICS_LINE_HEIGHT_PX
}

export function getCompactSyncedLyricsLineHeights(
  displayLines: SyncedLyricsDisplayLine[],
  settings: LyricsLayerSettings
): number[] {
  return displayLines.map((displayLine) => (
    getCompactSyncedLyricsDisplayLineHeight(displayLine, settings)
  ))
}

export interface LyricsWordTimingState {
  activeWordIndex: number
}

export function resolveLyricsWordTiming(
  words: LyricsWord[],
  currentTimeSeconds: number
): LyricsWordTimingState {
  if (words.length === 0) {
    return {
      activeWordIndex: -1
    }
  }

  const currentTimeMs = toPlaybackTimeMs(currentTimeSeconds)
  let activeWordIndex = -1
  for (let index = 0; index < words.length; index += 1) {
    if (words[index].timestampMs <= currentTimeMs) {
      activeWordIndex = index
      continue
    }
    break
  }

  return {
    activeWordIndex
  }
}

export type LyricsWordDisplayState = 'idle' | 'past' | 'active' | 'upcoming'

export function getLyricsWordDisplayState(
  wordIndex: number,
  timing: LyricsWordTimingState | null
): LyricsWordDisplayState {
  if (!timing) return 'idle'
  if (wordIndex < timing.activeWordIndex) return 'past'
  if (wordIndex === timing.activeWordIndex) return 'active'
  return 'upcoming'
}

export function hasRenderableSyncedLines(lines: LyricsLine[]): boolean {
  return lines.some(isRenderableSyncedLine)
}

function findCueIndexAtOrBefore(lines: LyricsLine[], currentTimeMs: number): number {
  if (lines.length === 0) return -1

  let low = 0
  let high = lines.length - 1
  let best = -1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (lines[mid].timestampMs <= currentTimeMs) {
      best = mid
      low = mid + 1
      continue
    }
    high = mid - 1
  }

  return best
}

function findDisplayIndexForCueIndex(displayLines: SyncedLyricsDisplayLine[], cueIndex: number): number {
  const match = displayLines.find((line) => line.cueIndex === cueIndex)
  return match?.displayIndex ?? -1
}

function findGapDisplayIndexAfterCue(displayLines: SyncedLyricsDisplayLine[], cueIndex: number): number {
  const match = displayLines.find((line) => line.kind === 'gap' && line.afterCueIndex === cueIndex)
  return match?.displayIndex ?? -1
}

function findPreviousDisplayIndex(displayLines: SyncedLyricsDisplayLine[], cueIndex: number): number {
  for (let index = displayLines.length - 1; index >= 0; index -= 1) {
    const displayLineCueIndex = displayLines[index].cueIndex ?? displayLines[index].afterCueIndex
    if (displayLineCueIndex !== null && displayLineCueIndex <= cueIndex) return displayLines[index].displayIndex
  }
  return -1
}

function findNextDisplayIndex(displayLines: SyncedLyricsDisplayLine[], cueIndex: number): number {
  for (const line of displayLines) {
    const displayLineCueIndex = line.cueIndex ?? line.afterCueIndex
    if (displayLineCueIndex !== null && displayLineCueIndex > cueIndex) return line.displayIndex
  }
  return -1
}

function resolveNeutralFocusLineIndex(displayLines: SyncedLyricsDisplayLine[], cueIndex: number): number {
  const currentLineIndex = findDisplayIndexForCueIndex(displayLines, cueIndex)
  if (currentLineIndex >= 0) return currentLineIndex
  const previousLineIndex = findPreviousDisplayIndex(displayLines, cueIndex)
  if (previousLineIndex >= 0) return previousLineIndex
  const nextLineIndex = findNextDisplayIndex(displayLines, cueIndex)
  if (nextLineIndex >= 0) return nextLineIndex
  return -1
}

export function resolveSyncedLyricsTiming(
  lines: LyricsLine[],
  currentTimeSeconds: number,
  options: SyncedLyricsTimingOptions = {}
): SyncedLyricsTimingState {
  const renderableLines = getRenderableSyncedLines(lines)
  const displayLines = getSyncedLyricsDisplayLines(lines, options)
  if (renderableLines.length === 0) {
    return {
      activeCueIndex: -1,
      activeLineIndex: -1,
      focusLineIndex: -1,
      isNeutral: true
    }
  }

  const currentTimeMs = toPlaybackTimeMs(currentTimeSeconds)
  const latestCueIndex = findCueIndexAtOrBefore(lines, currentTimeMs)
  if (latestCueIndex < 0) {
    return {
      activeCueIndex: -1,
      activeLineIndex: -1,
      focusLineIndex: 0,
      isNeutral: true
    }
  }

  const latestCue = lines[latestCueIndex]
  if (!isRenderableSyncedLine(latestCue)) {
    return {
      activeCueIndex: latestCueIndex,
      activeLineIndex: -1,
      focusLineIndex: resolveNeutralFocusLineIndex(displayLines, latestCueIndex),
      isNeutral: true
    }
  }

  const displayIndex = findDisplayIndexForCueIndex(displayLines, latestCueIndex)
  const postLineHoldMs = options.postLineHoldMs ?? LYRICS_POST_LINE_HOLD_MS
  const neutralGapThresholdMs = options.neutralGapThresholdMs ?? LYRICS_INFERRED_GAP_THRESHOLD_MS
  const nextCue = lines[latestCueIndex + 1] ?? null
  const nextCueGapMs = nextCue ? nextCue.timestampMs - latestCue.timestampMs : null
  const shouldNeutralizeForNextCue = nextCueGapMs !== null
    && nextCueGapMs >= neutralGapThresholdMs
    && currentTimeMs >= latestCue.timestampMs + postLineHoldMs

  const durationMs = toDurationMs(options.durationSeconds)
  const outroGapMs = durationMs === null ? null : durationMs - latestCue.timestampMs
  const shouldNeutralizeForOutro = !nextCue
    && outroGapMs !== null
    && outroGapMs >= neutralGapThresholdMs
    && currentTimeMs >= latestCue.timestampMs + postLineHoldMs

  if (shouldNeutralizeForNextCue || shouldNeutralizeForOutro) {
    const gapDisplayIndex = findGapDisplayIndexAfterCue(displayLines, latestCueIndex)
    return {
      activeCueIndex: latestCueIndex,
      activeLineIndex: -1,
      focusLineIndex: gapDisplayIndex >= 0 ? gapDisplayIndex : displayIndex,
      isNeutral: true
    }
  }

  return {
    activeCueIndex: latestCueIndex,
    activeLineIndex: displayIndex,
    focusLineIndex: displayIndex,
    isNeutral: false
  }
}

export function findActiveSyncedLineIndex(
  lines: LyricsLine[],
  currentTimeSeconds: number,
  options: SyncedLyricsTimingOptions = {}
): number {
  return resolveSyncedLyricsTiming(lines, currentTimeSeconds, options).activeLineIndex
}

export function getLyricsMetaChipText(options: {
  currentTrack: Track | { path: string } | null
  activeLyricsResult: LyricsLookupResult | null
  hasSyncedLyrics: boolean
  isLoading: boolean
  errorMessage: string
}): string {
  const { currentTrack, activeLyricsResult, hasSyncedLyrics, isLoading, errorMessage } = options
  if (!currentTrack) return 'No Track'
  if (isLoading && !activeLyricsResult) return 'Loading'
  if (activeLyricsResult?.status === 'hit') {
    const sourceLabel = getLyricsPayloadSourceLabel(activeLyricsResult.lyrics)
    const syncLabel = hasSyncedLyrics ? 'Synced' : 'Unsynced'
    const cachedLabel = activeLyricsResult.cached ? ' • Cached' : ''
    return `${sourceLabel} • ${syncLabel}${cachedLabel}`
  }
  if (activeLyricsResult?.status === 'transient_error') return 'Error'
  if (activeLyricsResult?.status === 'not_found') {
    if (activeLyricsResult.reason === 'online-disabled') return 'Online Off'
    if (activeLyricsResult.reason === 'provider-unavailable') return 'Lyrics Slow'
    return 'Not Found'
  }
  if (errorMessage) return 'Error'
  return 'Ready'
}

export function resolveLyricsBodyState(options: ResolveLyricsBodyStateOptions): LyricsBodyState {
  const { currentTrack, activeLyricsResult, isLoading, errorMessage, copy } = options

  if (!currentTrack) {
    return {
      kind: 'no-track',
      message: copy.noTrackMessage
    }
  }

  if (isLoading && !activeLyricsResult) {
    return {
      kind: 'loading',
      message: copy.loadingMessage
    }
  }

  if (activeLyricsResult?.status === 'transient_error') {
    return {
      kind: 'transient_error',
      message: activeLyricsResult.message
    }
  }

  if (activeLyricsResult?.status === 'not_found') {
    const message = activeLyricsResult.reason === 'online-disabled'
      ? copy.onlineDisabledMessage
      : activeLyricsResult.reason === 'provider-not-found'
        ? copy.providerNotFoundMessage
        : activeLyricsResult.reason === 'provider-unavailable'
          ? copy.providerUnavailableMessage
          : copy.embeddedMissingMessage

    return {
      kind: 'not_found',
      message,
      reason: activeLyricsResult.reason
    }
  }

  if (activeLyricsResult?.status === 'hit') {
    const sourceLabel = getLyricsPayloadSourceLabel(activeLyricsResult.lyrics)
    const cached = activeLyricsResult.cached
    const syncedLines = activeLyricsResult.lyrics.syncedLines
    if (hasRenderableSyncedLines(syncedLines)) {
      return {
        kind: 'hit_synced',
        sourceLabel,
        cached,
        syncedLines
      }
    }

    const plainLyrics = activeLyricsResult.lyrics.plainLyrics?.trim() ?? ''
    if (plainLyrics.length > 0) {
      return {
        kind: 'hit_plain',
        sourceLabel,
        cached,
        plainLyrics
      }
    }

    return {
      kind: 'hit_empty',
      message: copy.noReadableTextMessage,
      sourceLabel,
      cached
    }
  }

  if (errorMessage) {
    return {
      kind: 'transient_error',
      message: errorMessage
    }
  }

  return {
    kind: 'idle',
    message: copy.idleMessage
  }
}
