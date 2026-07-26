import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createDefaultDynamicPlaylistRules,
  normalizeDynamicPlaylistRules,
  type DynamicPlaylistAddedAtCondition,
  type DynamicPlaylistCondition,
  type DynamicPlaylistDateField,
  type DynamicPlaylistExactField,
  type DynamicPlaylistFavoriteCondition,
  type DynamicPlaylistLastPlayedCondition,
  type DynamicPlaylistNumericCondition,
  type DynamicPlaylistNumericField,
  type DynamicPlaylistRatedCondition,
  type DynamicPlaylistRulesV1,
  type DynamicPlaylistSourceCondition,
  type DynamicPlaylistSortField,
  type DynamicPlaylistTextCondition,
  type DynamicPlaylistTextField
} from '../../../shared/playlists/dynamicPlaylist'
import { useRatingsStore } from '../../stores/ratingsStore'
import StarRating from '../ratings/StarRating'

interface DynamicPlaylistPreviewTrack {
  path: string
  title: string
  artist: string
  album: string
}

export interface DynamicPlaylistPreview {
  track_count: number
  tracks: DynamicPlaylistPreviewTrack[]
}

interface DynamicPlaylistRuleEditorProps {
  rules: DynamicPlaylistRulesV1
  onRulesChange: (rules: DynamicPlaylistRulesV1) => void
  onPreview: (rules: DynamicPlaylistRulesV1) => Promise<DynamicPlaylistPreview>
  disabled?: boolean
}

type ConditionFieldKey = `${DynamicPlaylistCondition['kind']}:${DynamicPlaylistTextField | DynamicPlaylistNumericField | DynamicPlaylistDateField | DynamicPlaylistExactField}`

interface ConditionFieldOption {
  key: ConditionFieldKey
  label: string
}

interface DynamicPlaylistPreset {
  id: string
  label: string
  rules: DynamicPlaylistRulesV1
}

const PREVIEW_TRACK_LIMIT = 8

const FIELD_OPTIONS: readonly ConditionFieldOption[] = [
  { key: 'text:title', label: 'Title' },
  { key: 'text:artist', label: 'Artist' },
  { key: 'text:album', label: 'Album' },
  { key: 'text:album_artist', label: 'Album artist' },
  { key: 'text:genre', label: 'Genre' },
  { key: 'text:format', label: 'Format' },
  { key: 'text:musical_key', label: 'Key' },
  { key: 'numeric:play_count', label: 'Play count' },
  { key: 'numeric:year', label: 'Year' },
  { key: 'numeric:duration_seconds', label: 'Duration' },
  { key: 'numeric:bpm', label: 'BPM' },
  { key: 'numeric:rating', label: 'Rating' },
  { key: 'date:last_played_at', label: 'Last played' },
  { key: 'date:added_at', label: 'Added' },
  { key: 'exact:favorite', label: 'Favorite' },
  { key: 'exact:rated', label: 'Rated' },
  { key: 'exact:source_type', label: 'Source' }
]

const RATING_FIELD_KEYS: readonly ConditionFieldKey[] = ['numeric:rating', 'exact:rated']

const SORT_FIELD_LABELS: Record<DynamicPlaylistSortField, string> = {
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  added_at: 'Added',
  last_played_at: 'Last played',
  play_count: 'Play count',
  year: 'Year',
  duration_seconds: 'Duration',
  bpm: 'BPM',
  rating: 'Rating'
}

const PRESETS: readonly DynamicPlaylistPreset[] = [
  {
    id: 'unplayed',
    label: 'Unplayed',
    rules: {
      version: 1,
      conditions: [{ kind: 'numeric', field: 'play_count', operator: 'eq', value: 0 }],
      sort: { field: 'title', direction: 'asc' },
      limit: null
    }
  },
  {
    id: 'recently-added',
    label: 'Recently added',
    rules: {
      version: 1,
      conditions: [{ kind: 'date', field: 'added_at', operator: 'within_days', value: 30 }],
      sort: { field: 'added_at', direction: 'desc' },
      limit: null
    }
  },
  {
    id: 'favorites',
    label: 'Favorites',
    rules: {
      version: 1,
      conditions: [{ kind: 'exact', field: 'favorite', operator: 'is', value: true }],
      sort: { field: 'title', direction: 'asc' },
      limit: null
    }
  },
  {
    id: 'most-played',
    label: 'Most played',
    rules: {
      version: 1,
      conditions: [{ kind: 'numeric', field: 'play_count', operator: 'gte', value: 1 }],
      sort: { field: 'play_count', direction: 'desc' },
      limit: 100
    }
  },
  {
    id: 'not-recently',
    label: 'Not played recently',
    rules: {
      version: 1,
      conditions: [{ kind: 'date', field: 'last_played_at', operator: 'not_within_days', value: 30 }],
      sort: { field: 'last_played_at', direction: 'asc' },
      limit: null
    }
  },
  {
    id: 'local-only',
    label: 'Local only',
    rules: {
      version: 1,
      conditions: [{ kind: 'exact', field: 'source_type', operator: 'is', value: 'local' }],
      sort: { field: 'title', direction: 'asc' },
      limit: null
    }
  }
]

function createDefaultCondition(fieldKey: ConditionFieldKey = 'text:artist'): DynamicPlaylistCondition {
  const [kind, field] = fieldKey.split(':') as [DynamicPlaylistCondition['kind'], string]
  if (kind === 'numeric') {
    if (field === 'rating') {
      return { kind, field, operator: 'gte', value: 3.5 }
    }
    return { kind, field: field as DynamicPlaylistNumericField, operator: 'gte', value: field === 'play_count' ? 1 : 0 }
  }
  if (kind === 'date') {
    return field === 'last_played_at'
      ? { kind, field, operator: 'not_within_days', value: 30 }
      : { kind, field: 'added_at', operator: 'within_days', value: 30 }
  }
  if (kind === 'exact') {
    if (field === 'source_type') {
      return { kind, field, operator: 'is', value: 'local' }
    }
    // "Rated is false" is the natural starting point: find my unrated tracks.
    if (field === 'rated') {
      return { kind, field, operator: 'is', value: false }
    }
    return { kind, field: 'favorite', operator: 'is', value: true }
  }
  return { kind, field: field as DynamicPlaylistTextField, operator: 'contains', value: '' }
}

function getConditionFieldKey(condition: DynamicPlaylistCondition): ConditionFieldKey {
  return `${condition.kind}:${condition.field}` as ConditionFieldKey
}

function updateRulesCondition(
  rules: DynamicPlaylistRulesV1,
  index: number,
  condition: DynamicPlaylistCondition
): DynamicPlaylistRulesV1 {
  return {
    ...rules,
    conditions: rules.conditions.map((entry, entryIndex) => (
      entryIndex === index ? condition : entry
    ))
  }
}

function removeRulesCondition(rules: DynamicPlaylistRulesV1, index: number): DynamicPlaylistRulesV1 {
  return {
    ...rules,
    conditions: rules.conditions.filter((_, entryIndex) => entryIndex !== index)
  }
}

function formatTrackPreviewSubtitle(track: DynamicPlaylistPreview['tracks'][number]): string {
  const parts = [track.artist, track.album].map((value) => value?.trim()).filter(Boolean)
  return parts.join(' - ') || track.path
}

function updateTextOperator(
  condition: DynamicPlaylistTextCondition,
  operator: DynamicPlaylistTextCondition['operator']
): DynamicPlaylistTextCondition {
  return { ...condition, operator }
}

function updateNumericOperator(
  condition: DynamicPlaylistNumericCondition,
  operator: DynamicPlaylistNumericCondition['operator']
): DynamicPlaylistNumericCondition {
  return { ...condition, operator }
}

function updateDateOperator(
  condition: DynamicPlaylistLastPlayedCondition | DynamicPlaylistAddedAtCondition,
  operator: string
): DynamicPlaylistLastPlayedCondition | DynamicPlaylistAddedAtCondition {
  if (condition.field === 'last_played_at') {
    if (operator === 'never') return { kind: 'date', field: 'last_played_at', operator }
    return {
      kind: 'date',
      field: 'last_played_at',
      operator: operator === 'within_days' ? 'within_days' : 'not_within_days',
      value: condition.value ?? 30
    }
  }

  return {
    kind: 'date',
    field: 'added_at',
    operator: operator === 'older_than_days' ? 'older_than_days' : 'within_days',
    value: condition.value
  }
}

function updateExactOperator(
  condition: DynamicPlaylistSourceCondition | DynamicPlaylistFavoriteCondition | DynamicPlaylistRatedCondition,
  operator: DynamicPlaylistSourceCondition['operator']
): DynamicPlaylistSourceCondition | DynamicPlaylistFavoriteCondition | DynamicPlaylistRatedCondition {
  return { ...condition, operator } as DynamicPlaylistSourceCondition | DynamicPlaylistFavoriteCondition | DynamicPlaylistRatedCondition
}

function renderConditionOperator(
  condition: DynamicPlaylistCondition,
  onChange: (condition: DynamicPlaylistCondition) => void,
  disabled: boolean
) {
  if (condition.kind === 'text') {
    return (
      <select className="playlist-dynamic-select" value={condition.operator} onChange={(event) => onChange(updateTextOperator(condition, event.target.value as DynamicPlaylistTextCondition['operator']))} disabled={disabled}>
        <option value="contains">contains</option>
        <option value="is">is</option>
        <option value="is_not">is not</option>
      </select>
    )
  }

  if (condition.kind === 'numeric') {
    return (
      <select className="playlist-dynamic-select" value={condition.operator} onChange={(event) => onChange(updateNumericOperator(condition, event.target.value as DynamicPlaylistNumericCondition['operator']))} disabled={disabled}>
        <option value="eq">is</option>
        <option value="gte">is at least</option>
        <option value="lte">is at most</option>
      </select>
    )
  }

  if (condition.kind === 'date') {
    const options = condition.field === 'last_played_at'
      ? [
          ['never', 'never'],
          ['within_days', 'within days'],
          ['not_within_days', 'not within days']
        ]
      : [
          ['within_days', 'within days'],
          ['older_than_days', 'older than days']
        ]
    return (
      <select className="playlist-dynamic-select" value={condition.operator} onChange={(event) => onChange(updateDateOperator(condition, event.target.value))} disabled={disabled}>
        {options.map(([value, label]) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>
    )
  }

  return (
    <select className="playlist-dynamic-select" value={condition.operator} onChange={(event) => onChange(updateExactOperator(condition, event.target.value as DynamicPlaylistSourceCondition['operator']))} disabled={disabled}>
      <option value="is">is</option>
      <option value="is_not">is not</option>
    </select>
  )
}

interface DynamicPlaylistDayInputProps {
  condition: DynamicPlaylistLastPlayedCondition | DynamicPlaylistAddedAtCondition
  needsValue: boolean
  onChange: (condition: DynamicPlaylistCondition) => void
  disabled: boolean
}

function DynamicPlaylistDayInput({
  condition,
  needsValue,
  onChange,
  disabled
}: DynamicPlaylistDayInputProps) {
  const initialValue = needsValue ? String(condition.value ?? 30) : ''
  // Keep the DOM value uncontrolled so the browser can retain transient
  // decimal text such as "0." while the rules continue to store a number.
  const inputRef = useRef<HTMLInputElement>(null)
  const lastEmittedValueRef = useRef(condition.value)
  const lastNeedsValueRef = useRef(needsValue)

  useEffect(() => {
    if (
      Object.is(condition.value, lastEmittedValueRef.current)
      && needsValue === lastNeedsValueRef.current
    ) return
    lastEmittedValueRef.current = condition.value
    lastNeedsValueRef.current = needsValue
    if (inputRef.current) {
      inputRef.current.value = needsValue ? String(condition.value ?? 30) : ''
    }
  }, [condition.value, needsValue])

  return (
    <input
      ref={inputRef}
      className="playlist-dynamic-input"
      type="number"
      min={0}
      step={(condition.value ?? 0) < 1 ? 0.5 : 1}
      defaultValue={initialValue}
      onChange={(event) => {
        const rawValue = event.target.value
        const nextValue = rawValue.trim() ? Number(rawValue) : 0
        lastEmittedValueRef.current = nextValue
        onChange({ ...condition, value: nextValue } as DynamicPlaylistCondition)
      }}
      placeholder={needsValue ? 'Days' : ''}
      disabled={disabled || !needsValue}
    />
  )
}

function renderConditionValue(
  condition: DynamicPlaylistCondition,
  onChange: (condition: DynamicPlaylistCondition) => void,
  disabled: boolean
) {
  if (condition.kind === 'text') {
    return (
      <input
        className="playlist-dynamic-input"
        value={condition.value}
        onChange={(event) => onChange({ ...condition, value: event.target.value })}
        placeholder="Value"
        disabled={disabled}
      />
    )
  }

  if (condition.kind === 'numeric') {
    if (condition.field === 'rating') {
      return (
        <div className="playlist-dynamic-rating-value">
          <StarRating
            value={Number.isFinite(condition.value) ? condition.value : null}
            size="md"
            ariaLabel="Rating filter value"
            onCommit={disabled ? undefined : (value) => {
              // A filter always needs a value; ignore the click-to-clear commit.
              if (value !== null) onChange({ ...condition, value })
            }}
          />
        </div>
      )
    }
    return (
      <input
        className="playlist-dynamic-input"
        type="number"
        value={Number.isFinite(condition.value) ? String(condition.value) : ''}
        onChange={(event) => onChange({ ...condition, value: Number(event.target.value) })}
        disabled={disabled}
      />
    )
  }

  if (condition.kind === 'date') {
    const needsValue = !(condition.field === 'last_played_at' && condition.operator === 'never')
    return (
      <DynamicPlaylistDayInput
        condition={condition}
        needsValue={needsValue}
        onChange={onChange}
        disabled={disabled}
      />
    )
  }

  if (condition.field === 'source_type') {
    return (
      <select
        className="playlist-dynamic-select"
        value={condition.value}
        onChange={(event) => onChange({ ...condition, value: event.target.value as DynamicPlaylistSourceCondition['value'] })}
        disabled={disabled}
      >
        <option value="local">Local</option>
        <option value="subsonic">Subsonic</option>
        <option value="jellyfin">Jellyfin</option>
      </select>
    )
  }

  return (
    <select
      className="playlist-dynamic-select"
      value={condition.value ? 'true' : 'false'}
      onChange={(event) => onChange({ ...condition, value: event.target.value === 'true' })}
      disabled={disabled}
    >
      <option value="true">True</option>
      <option value="false">False</option>
    </select>
  )
}

export default function DynamicPlaylistRuleEditor({
  rules,
  onRulesChange,
  onPreview,
  disabled = false
}: DynamicPlaylistRuleEditorProps) {
  const [preview, setPreview] = useState<DynamicPlaylistPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const ratingsEnabled = useRatingsStore((s) => s.enabled)

  // With ratings opted out, hide the rating fields for NEW conditions but keep
  // them selectable on rows that already use them (existing playlists keep
  // working; the select must not render an invalid value).
  const visibleFieldOptions = useMemo(() => (
    ratingsEnabled
      ? FIELD_OPTIONS
      : FIELD_OPTIONS.filter((option) => !RATING_FIELD_KEYS.includes(option.key))
  ), [ratingsEnabled])

  const fieldOptionsForCondition = (condition: DynamicPlaylistCondition): readonly ConditionFieldOption[] => (
    RATING_FIELD_KEYS.includes(getConditionFieldKey(condition)) ? FIELD_OPTIONS : visibleFieldOptions
  )

  const visibleSortFields = useMemo(() => (
    Object.entries(SORT_FIELD_LABELS).filter(([field]) => (
      field !== 'rating' || ratingsEnabled || rules.sort.field === 'rating'
    ))
  ), [ratingsEnabled, rules.sort.field])

  const normalizedRulesError = useMemo(() => {
    try {
      normalizeDynamicPlaylistRules(rules)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : 'Rules are incomplete.'
    }
  }, [rules])

  useEffect(() => {
    let didCancel = false
    const timeoutId = window.setTimeout(() => {
      const loadPreview = async () => {
        setIsPreviewLoading(true)
        setPreviewError(null)
        try {
          const normalizedRules = normalizeDynamicPlaylistRules(rules)
          const nextPreview = await onPreview(normalizedRules)
          if (!didCancel) setPreview(nextPreview)
        } catch (error) {
          if (!didCancel) {
            setPreview(null)
            setPreviewError(error instanceof Error ? error.message : 'Preview failed.')
          }
        } finally {
          if (!didCancel) setIsPreviewLoading(false)
        }
      }
      void loadPreview()
    }, 300)

    return () => {
      didCancel = true
      window.clearTimeout(timeoutId)
    }
  }, [onPreview, rules])

  const addCondition = () => {
    onRulesChange({
      ...rules,
      conditions: [...rules.conditions, createDefaultCondition()]
    })
  }

  const previewTracks = preview?.tracks.slice(0, PREVIEW_TRACK_LIMIT) ?? []
  const hasConditions = rules.conditions.length > 0

  return (
    <div className="playlist-dynamic-builder">
      <div className="playlist-dynamic-builder-main">
        <div className="playlist-dynamic-presets">
          <span className="playlist-create-label">Starters</span>
          <div className="playlist-dynamic-preset-row">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="playlist-dynamic-preset-chip"
                onClick={() => onRulesChange(preset.rules)}
                disabled={disabled}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <div className="playlist-dynamic-section">
          <div className="playlist-dynamic-section-header">
            <span className="playlist-create-label">Filters</span>
            <div className="playlist-dynamic-section-actions">
              <button type="button" className="playlist-create-cover-btn subtle" onClick={() => onRulesChange(createDefaultDynamicPlaylistRules())} disabled={disabled}>
                Reset
              </button>
              <button type="button" className="playlist-create-cover-btn" onClick={addCondition} disabled={disabled}>
                Add filter
              </button>
            </div>
          </div>

          {rules.conditions.length === 0 ? (
            <div className="playlist-dynamic-empty-rule">No filters. All available tracks will match.</div>
          ) : (
            <div className="playlist-dynamic-rule-list">
              {rules.conditions.map((condition, index) => (
                <div className="playlist-dynamic-rule-row" key={index}>
                  <span className="playlist-dynamic-rule-prefix">
                    {index === 0 ? 'Match tracks where' : 'and'}
                  </span>
                  <select
                    className="playlist-dynamic-select"
                    value={getConditionFieldKey(condition)}
                    onChange={(event) => onRulesChange(updateRulesCondition(
                      rules,
                      index,
                      createDefaultCondition(event.target.value as ConditionFieldKey)
                    ))}
                    disabled={disabled}
                  >
                    {fieldOptionsForCondition(condition).map((option) => (
                      <option key={option.key} value={option.key}>{option.label}</option>
                    ))}
                  </select>
                  {renderConditionOperator(condition, (next) => onRulesChange(updateRulesCondition(rules, index, next)), disabled)}
                  {renderConditionValue(condition, (next) => onRulesChange(updateRulesCondition(rules, index, next)), disabled)}
                  <button
                    type="button"
                    className="playlist-dynamic-remove-btn"
                    onClick={() => onRulesChange(removeRulesCondition(rules, index))}
                    aria-label="Remove filter"
                    disabled={disabled}
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <aside className="playlist-dynamic-preview" role={previewError || normalizedRulesError ? 'alert' : 'status'}>
        <div className="playlist-dynamic-preview-header">
          <span>Preview</span>
          <span>{isPreviewLoading ? 'Loading' : `${preview?.track_count ?? 0} ${preview?.track_count === 1 ? 'track' : 'tracks'}`}</span>
        </div>
        <div className="playlist-dynamic-preview-order">
          <span className="playlist-create-label">Result order</span>
          <div className="playlist-dynamic-preview-order-grid">
            <label className="playlist-create-field">
              <span className="playlist-create-label">By</span>
              <select
                className="playlist-dynamic-select"
                value={rules.sort.field}
                onChange={(event) => onRulesChange({
                  ...rules,
                  sort: { ...rules.sort, field: event.target.value as DynamicPlaylistSortField }
                })}
                disabled={disabled}
              >
                {visibleSortFields.map(([field, label]) => (
                  <option key={field} value={field}>{label}</option>
                ))}
              </select>
            </label>
            <label className="playlist-create-field">
              <span className="playlist-create-label">Direction</span>
              <select
                className="playlist-dynamic-select"
                value={rules.sort.direction}
                onChange={(event) => onRulesChange({
                  ...rules,
                  sort: { ...rules.sort, direction: event.target.value === 'desc' ? 'desc' : 'asc' }
                })}
                disabled={disabled}
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </label>
            <label className="playlist-create-field">
              <span className="playlist-create-label">Limit</span>
              <input
                className="playlist-dynamic-input playlist-dynamic-order-limit"
                type="number"
                min={1}
                max={5000}
                value={rules.limit ?? ''}
                onChange={(event) => onRulesChange({
                  ...rules,
                  limit: event.target.value.trim() ? Number(event.target.value) : null
                })}
                placeholder="None"
                disabled={disabled}
              />
            </label>
          </div>
        </div>
        {(previewError || normalizedRulesError) ? (
          <div className="playlist-dynamic-preview-error">{previewError ?? normalizedRulesError}</div>
        ) : (
          <>
            {!hasConditions && (
              <div className="playlist-dynamic-preview-hint">
                Add filters to narrow this playlist.
              </div>
            )}
            {previewTracks.length > 0 ? (
              <div className={`playlist-dynamic-preview-list ${!hasConditions ? 'is-muted' : ''}`}>
                {previewTracks.map((track) => (
                  <div className="playlist-dynamic-preview-row" key={track.path}>
                    <span className="playlist-dynamic-preview-title">{track.title}</span>
                    <span className="playlist-dynamic-preview-subtitle">{formatTrackPreviewSubtitle(track)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="playlist-dynamic-preview-empty">No matching tracks</div>
            )}
          </>
        )}
      </aside>
    </div>
  )
}
