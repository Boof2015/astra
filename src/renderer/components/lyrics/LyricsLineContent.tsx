import type { CSSProperties, ReactNode } from 'react'
import type { LyricsFurigana } from '../../../types/lyrics'
import type { LyricsDisplaySettings } from '../../stores/lyricsDisplaySettingsStore'
import {
  hasEnabledLyricsLineExtra,
  getPreferredLyricsTranslation,
  getSyncedLyricsGapProgress,
  resolveLyricsWordTiming,
  type SyncedLyricsDisplayLine
} from '../../utils/lyricsPresentation'

interface LyricsLineContentProps {
  displayLine: SyncedLyricsDisplayLine
  currentTimeSeconds: number
  isActive: boolean
  settings: LyricsDisplaySettings
  seekTimeSeconds?: number | null
  seekTabIndex?: number
  onSeek?: (timeSeconds: number) => void
}

function renderTextWithFurigana(
  text: string,
  furigana: LyricsFurigana[] | undefined,
  enabled: boolean
): ReactNode {
  if (!enabled || !furigana || furigana.length === 0) return text

  const parts: ReactNode[] = []
  let cursor = 0
  const sorted = [...furigana].sort((left, right) => left.start - right.start)

  sorted.forEach((entry, index) => {
    if (entry.start < cursor || entry.end > text.length) return
    if (entry.start > cursor) {
      parts.push(text.slice(cursor, entry.start))
    }
    parts.push(
      <ruby key={`ruby-${entry.start}-${entry.end}-${index}`}>
        {text.slice(entry.start, entry.end)}
        <rt>{entry.reading}</rt>
      </ruby>
    )
    cursor = entry.end
  })

  if (cursor < text.length) {
    parts.push(text.slice(cursor))
  }

  return parts.length > 0 ? parts : text
}

function getWordStyle(progress: number): CSSProperties {
  return {
    '--lyrics-word-progress': String(progress)
  } as CSSProperties
}

export default function LyricsLineContent({
  displayLine,
  currentTimeSeconds,
  isActive,
  settings,
  seekTimeSeconds = null,
  seekTabIndex,
  onSeek
}: LyricsLineContentProps) {
  if (displayLine.kind === 'gap') {
    const progress = getSyncedLyricsGapProgress(displayLine, currentTimeSeconds)
    if (progress === null) return null
    return (
      <span className="lyrics-gap-progress">
        <span
          className="lyrics-gap-progress-fill"
          style={{ transform: `scaleX(${progress})` }}
        />
      </span>
    )
  }

  const line = displayLine.line
  const words = settings.wordTimingEnabled ? line.words ?? [] : []
  const wordTiming = isActive ? resolveLyricsWordTiming(words, currentTimeSeconds) : null
  const translation = settings.translationsEnabled
    ? getPreferredLyricsTranslation(line, settings.translationLanguagePriority)
    : null
  const hasRichExtra = hasEnabledLyricsLineExtra(line, settings)
  const contentClassName = [
    'lyrics-line-content',
    hasRichExtra ? 'has-rich-lyrics' : ''
  ].join(' ').trim()
  const normalizedSeekTime = typeof seekTimeSeconds === 'number' && Number.isFinite(seekTimeSeconds)
    ? seekTimeSeconds
    : null

  const content = (
    <>
      <span className="lyrics-line-main">
        {settings.voiceLabelsEnabled && line.voice && (
          <span className="lyrics-line-voice">{line.voice}</span>
        )}
        {words.length > 0 ? (
          <span className="lyrics-word-sequence">
            {words.map((word, index) => {
              const progress = wordTiming?.progressByIndex[index] ?? 0
              const isActiveWord = wordTiming?.activeWordIndex === index
              const isPastWord = wordTiming != null && index < wordTiming.activeWordIndex
              return (
                <span
                  key={`${word.timestampMs}-${index}`}
                  className={[
                    'lyrics-word',
                    isActiveWord ? 'is-active' : '',
                    isPastWord ? 'is-past' : ''
                  ].join(' ').trim()}
                  style={getWordStyle(progress)}
                >
                  {renderTextWithFurigana(word.text, word.furigana, settings.furiganaEnabled)}
                </span>
              )
            })}
          </span>
        ) : (
          <span className="lyrics-line-text">
            {renderTextWithFurigana(line.text, line.furigana, settings.furiganaEnabled)}
          </span>
        )}
      </span>
      {translation && (
        <span className="lyrics-line-translation">{translation.text}</span>
      )}
    </>
  )

  if (normalizedSeekTime !== null && onSeek) {
    return (
      <button
        type="button"
        className={`${contentClassName} lyrics-line-seek-button`}
        onClick={() => onSeek(normalizedSeekTime)}
        tabIndex={seekTabIndex}
      >
        {content}
      </button>
    )
  }

  return (
    <span className={contentClassName}>
      {content}
    </span>
  )
}
