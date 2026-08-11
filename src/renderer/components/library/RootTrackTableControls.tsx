import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ROOT_TRACK_COLUMN_LABELS,
  createDefaultRootTrackTableLayout,
  getDefaultTrackSortDirection,
  getVisibleRootTrackColumnIds,
  normalizeRootTrackTableLayout,
  normalizeTrackSortRules,
  reorderTrackSortRules,
  type RootTrackColumnId,
  type RootTrackTableLayout,
  type TrackSortRule
} from '../../utils/rootTrackTable'

interface RootTrackTableControlsProps {
  layout: RootTrackTableLayout
  sortRules: readonly TrackSortRule[]
  ratingsEnabled: boolean
  responsiveHiddenColumns: readonly RootTrackColumnId[]
  onLayoutChange: (layout: RootTrackTableLayout) => void
  onSortRulesChange: (rules: TrackSortRule[]) => void
}

type OpenPanel = 'sort' | 'columns' | null

function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return [...items]
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

export default function RootTrackTableControls({
  layout,
  sortRules,
  ratingsEnabled,
  responsiveHiddenColumns,
  onLayoutChange,
  onSortRulesChange
}: RootTrackTableControlsProps) {
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null)
  const [draggedColumn, setDraggedColumn] = useState<RootTrackColumnId | null>(null)
  const [draggedSortIndex, setDraggedSortIndex] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const normalizedLayout = useMemo(() => normalizeRootTrackTableLayout(layout), [layout])
  const visibleColumnIds = useMemo(
    () => getVisibleRootTrackColumnIds(normalizedLayout, ratingsEnabled),
    [normalizedLayout, ratingsEnabled]
  )
  const normalizedSortRules = useMemo(
    () => normalizeTrackSortRules(sortRules, { visibleColumns: visibleColumnIds, ratingsEnabled }),
    [ratingsEnabled, sortRules, visibleColumnIds]
  )
  const availableSortColumns = normalizedLayout.columns.filter((entry) => (
    entry.visible && (entry.id !== 'rating' || ratingsEnabled)
  ))

  useEffect(() => {
    if (!openPanel) return
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpenPanel(null)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenPanel(null)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [openPanel])

  const commitLayout = (nextLayout: RootTrackTableLayout, nextRules: readonly TrackSortRule[] = normalizedSortRules) => {
    const normalized = normalizeRootTrackTableLayout(nextLayout)
    const nextVisible = getVisibleRootTrackColumnIds(normalized, ratingsEnabled)
    onLayoutChange(normalized)
    onSortRulesChange(normalizeTrackSortRules(nextRules, {
      visibleColumns: nextVisible,
      ratingsEnabled
    }))
  }

  const moveColumn = (columnId: RootTrackColumnId, delta: -1 | 1) => {
    const index = normalizedLayout.columns.findIndex((entry) => entry.id === columnId)
    const target = index + delta
    if (index <= 0 || target <= 0 || target >= normalizedLayout.columns.length) return
    commitLayout({ columns: moveItem(normalizedLayout.columns, index, target) })
  }

  const dropColumnBefore = (targetId: RootTrackColumnId) => {
    if (!draggedColumn || draggedColumn === targetId || draggedColumn === 'title' || targetId === 'title') return
    const from = normalizedLayout.columns.findIndex((entry) => entry.id === draggedColumn)
    const to = normalizedLayout.columns.findIndex((entry) => entry.id === targetId)
    if (from < 1 || to < 1) return
    commitLayout({ columns: moveItem(normalizedLayout.columns, from, to) })
    setDraggedColumn(null)
  }

  const updateSortRule = (index: number, patch: Partial<TrackSortRule>) => {
    const next = normalizedSortRules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule)
    onSortRulesChange(normalizeTrackSortRules(next, { visibleColumns: visibleColumnIds, ratingsEnabled }))
  }

  const moveSortRule = (index: number, delta: -1 | 1) => {
    const target = index + delta
    if (target < 0 || target >= normalizedSortRules.length) return
    onSortRulesChange(reorderTrackSortRules(normalizedSortRules, index, target))
  }

  const dropSortRuleBefore = (targetIndex: number) => {
    if (draggedSortIndex === null || draggedSortIndex === targetIndex) return
    onSortRulesChange(reorderTrackSortRules(normalizedSortRules, draggedSortIndex, targetIndex))
    setDraggedSortIndex(null)
  }

  const addSortRule = () => {
    const used = new Set(normalizedSortRules.map((rule) => rule.key))
    const nextColumn = availableSortColumns.find((entry) => !used.has(entry.id))
    if (!nextColumn) return
    onSortRulesChange([
      ...normalizedSortRules,
      { key: nextColumn.id, direction: getDefaultTrackSortDirection(nextColumn.id) }
    ])
  }

  const responsiveHiddenCount = responsiveHiddenColumns.length

  return (
    <div className="root-track-table-controls" ref={rootRef}>
      <button
        type="button"
        className={`root-track-table-control-btn ${openPanel === 'sort' ? 'active' : ''}`}
        onClick={() => setOpenPanel((current) => current === 'sort' ? null : 'sort')}
        aria-expanded={openPanel === 'sort'}
        aria-haspopup="dialog"
      >
        Sort
        {normalizedSortRules.length > 1 && (
          <span className="root-track-table-control-count">{normalizedSortRules.length}</span>
        )}
      </button>
      <button
        type="button"
        className={`root-track-table-control-btn ${openPanel === 'columns' ? 'active' : ''}`}
        onClick={() => setOpenPanel((current) => current === 'columns' ? null : 'columns')}
        aria-expanded={openPanel === 'columns'}
        aria-haspopup="dialog"
      >
        Columns
        {responsiveHiddenCount > 0 && (
          <span className="root-track-table-hidden-count">{responsiveHiddenCount} hidden at this width</span>
        )}
      </button>

      {openPanel === 'sort' && (
        <div className="root-track-table-panel root-track-sort-panel" role="dialog" aria-label="Track sort priorities">
          <div className="root-track-table-panel-heading">
            <div>
              <strong>Sort priorities</strong>
              <span>Drag or use arrow buttons to reorder.</span>
            </div>
          </div>
          <div className="root-track-sort-rules">
            {normalizedSortRules.map((rule, index) => (
              <div
                className="root-track-sort-rule"
                key={rule.key}
                draggable
                onDragStart={() => setDraggedSortIndex(index)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => dropSortRuleBefore(index)}
                onDragEnd={() => setDraggedSortIndex(null)}
              >
                <span className="root-track-drag-handle" aria-hidden="true">⠿</span>
                {normalizedSortRules.length > 1 && (
                  <span className="root-track-rule-priority" aria-label={`Priority ${index + 1}`}>{index + 1}</span>
                )}
                <select
                  value={rule.key}
                  aria-label={`Sort priority ${index + 1} field`}
                  onChange={(event) => updateSortRule(index, { key: event.target.value as RootTrackColumnId })}
                >
                  {availableSortColumns.map((entry) => {
                    const usedElsewhere = normalizedSortRules.some((candidate, candidateIndex) => (
                      candidateIndex !== index && candidate.key === entry.id
                    ))
                    return <option key={entry.id} value={entry.id} disabled={usedElsewhere}>{ROOT_TRACK_COLUMN_LABELS[entry.id]}</option>
                  })}
                </select>
                <button
                  type="button"
                  className="root-track-rule-direction"
                  onClick={() => updateSortRule(index, { direction: rule.direction === 'asc' ? 'desc' : 'asc' })}
                  aria-label={`Reverse ${ROOT_TRACK_COLUMN_LABELS[rule.key]} sort direction`}
                >
                  {rule.direction === 'desc' ? '↑' : '↓'}
                </button>
                <div className="root-track-row-actions">
                  <button type="button" onClick={() => moveSortRule(index, -1)} disabled={index === 0} aria-label={`Move ${ROOT_TRACK_COLUMN_LABELS[rule.key]} sort earlier`}>↑</button>
                  <button type="button" onClick={() => moveSortRule(index, 1)} disabled={index === normalizedSortRules.length - 1} aria-label={`Move ${ROOT_TRACK_COLUMN_LABELS[rule.key]} sort later`}>↓</button>
                  <button
                    type="button"
                    onClick={() => onSortRulesChange(normalizeTrackSortRules(normalizedSortRules.filter((_, ruleIndex) => ruleIndex !== index), { visibleColumns: visibleColumnIds, ratingsEnabled }))}
                    disabled={normalizedSortRules.length === 1}
                    aria-label={`Remove ${ROOT_TRACK_COLUMN_LABELS[rule.key]} sort`}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="root-track-table-panel-footer">
            <button type="button" onClick={addSortRule} disabled={normalizedSortRules.length >= availableSortColumns.length}>Add priority</button>
            <button type="button" onClick={() => onSortRulesChange([{ key: 'title', direction: 'asc' }])}>Reset sort</button>
          </div>
        </div>
      )}

      {openPanel === 'columns' && (
        <div className="root-track-table-panel root-track-columns-panel" role="dialog" aria-label="Track table columns">
          <div className="root-track-table-panel-heading">
            <div>
              <strong>Columns</strong>
              <span>Drag or use arrow buttons to change order.</span>
            </div>
          </div>
          <div className="root-track-column-options">
            {normalizedLayout.columns
              .filter((entry) => entry.id !== 'rating' || ratingsEnabled)
              .map((entry, index, displayedColumns) => (
                <div
                  className="root-track-column-option"
                  key={entry.id}
                  draggable={entry.id !== 'title'}
                  onDragStart={() => setDraggedColumn(entry.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => dropColumnBefore(entry.id)}
                  onDragEnd={() => setDraggedColumn(null)}
                >
                  <span className="root-track-drag-handle" aria-hidden="true">{entry.id === 'title' ? '•' : '⠿'}</span>
                  <label>
                    <input
                      type="checkbox"
                      checked={entry.visible}
                      disabled={entry.id === 'title'}
                      onChange={(event) => commitLayout({
                        columns: normalizedLayout.columns.map((column) => (
                          column.id === entry.id ? { ...column, visible: event.target.checked } : column
                        ))
                      })}
                    />
                    <span>{ROOT_TRACK_COLUMN_LABELS[entry.id]}</span>
                    {entry.id === 'title' && <small>pinned</small>}
                  </label>
                  {entry.id !== 'title' && (
                    <div className="root-track-row-actions">
                      <button type="button" onClick={() => moveColumn(entry.id, -1)} disabled={index <= 1} aria-label={`Move ${ROOT_TRACK_COLUMN_LABELS[entry.id]} column left`}>↑</button>
                      <button type="button" onClick={() => moveColumn(entry.id, 1)} disabled={index === displayedColumns.length - 1} aria-label={`Move ${ROOT_TRACK_COLUMN_LABELS[entry.id]} column right`}>↓</button>
                    </div>
                  )}
                </div>
              ))}
          </div>
          <div className="root-track-table-panel-footer">
            <button type="button" onClick={() => commitLayout(createDefaultRootTrackTableLayout({ showRating: ratingsEnabled }))}>Reset columns</button>
          </div>
        </div>
      )}
    </div>
  )
}
