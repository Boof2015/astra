import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { createPortal } from 'react-dom'
import {
  ROOT_TRACK_COLUMN_LABELS,
  createDefaultRootTrackTableLayout,
  getDefaultTrackSortDirection,
  getTrackSortDirectionLabel,
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

function layoutsMatch(left: RootTrackTableLayout, right: RootTrackTableLayout): boolean {
  return left.columns.length === right.columns.length && left.columns.every((entry, index) => (
    entry.id === right.columns[index]?.id && entry.visible === right.columns[index]?.visible
  ))
}

function GripIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
      <circle cx="4" cy="3" r="1" />
      <circle cx="10" cy="3" r="1" />
      <circle cx="4" cy="7" r="1" />
      <circle cx="10" cy="7" r="1" />
      <circle cx="4" cy="11" r="1" />
      <circle cx="10" cy="11" r="1" />
    </svg>
  )
}

function ArrowIcon({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {direction === 'up' ? (
        <>
          <path d="M8 13V3" />
          <path d="m4.5 6.5 3.5-3.5 3.5 3.5" />
        </>
      ) : (
        <>
          <path d="M8 3v10" />
          <path d="m4.5 9.5 3.5 3.5 3.5-3.5" />
        </>
      )}
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="2" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={open ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} />
    </svg>
  )
}

interface TrackControlSelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

interface TrackControlSelectProps<T extends string> {
  value: T | null
  options: readonly TrackControlSelectOption<T>[]
  placeholder?: string
  ariaLabel: string
  disabled?: boolean
  className?: string
  onChange: (value: T) => void
}

function TrackControlSelect<T extends string>({
  value,
  options,
  placeholder = 'Choose an option',
  ariaLabel,
  disabled = false,
  className = '',
  onChange
}: TrackControlSelectProps<T>) {
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const pendingKeyboardFocus = useRef<'selected' | 'first' | 'last' | null>(null)
  const listboxId = useId()
  const selectedOption = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    const updateMenuPosition = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const viewportPadding = 8
      const desiredHeight = Math.min(options.length * 30 + 8, 280)
      const spaceBelow = window.innerHeight - rect.bottom - viewportPadding
      const openUpward = spaceBelow < Math.min(desiredHeight, 160) && rect.top > spaceBelow
      const maxHeight = Math.max(80, Math.min(280, openUpward ? rect.top - 12 : spaceBelow - 4))
      const width = Math.max(rect.width, 132)
      const left = Math.min(
        Math.max(viewportPadding, rect.left),
        Math.max(viewportPadding, window.innerWidth - width - viewportPadding)
      )
      const top = openUpward
        ? Math.max(viewportPadding, rect.top - Math.min(desiredHeight, maxHeight) - 4)
        : rect.bottom + 4
      setMenuPosition({ left, top, width, maxHeight })
    }
    updateMenuPosition()
    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', updateMenuPosition, true)
    return () => {
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', updateMenuPosition, true)
    }
  }, [open, options.length])

  useEffect(() => {
    if (!open || !menuPosition || !pendingKeyboardFocus.current) return
    const enabledIndices = options
      .map((option, index) => option.disabled ? -1 : index)
      .filter((index) => index >= 0)
    const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled)
    const focusTarget = pendingKeyboardFocus.current === 'last'
      ? enabledIndices[enabledIndices.length - 1]
      : pendingKeyboardFocus.current === 'first'
        ? enabledIndices[0]
        : selectedIndex >= 0 ? selectedIndex : enabledIndices[0]
    pendingKeyboardFocus.current = null
    const frameId = window.requestAnimationFrame(() => optionRefs.current[focusTarget]?.focus())
    return () => window.cancelAnimationFrame(frameId)
  }, [menuPosition, open, options, value])

  useEffect(() => {
    if (!disabled) return
    setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  const closeAndFocusTrigger = () => {
    triggerRef.current?.focus()
    setOpen(false)
  }

  const focusRelativeOption = (currentIndex: number, delta: -1 | 1) => {
    const enabledIndices = options
      .map((option, index) => option.disabled ? -1 : index)
      .filter((index) => index >= 0)
    const currentEnabledIndex = enabledIndices.indexOf(currentIndex)
    const nextEnabledIndex = Math.min(
      enabledIndices.length - 1,
      Math.max(0, currentEnabledIndex + delta)
    )
    optionRefs.current[enabledIndices[nextEnabledIndex]]?.focus()
  }

  const handleOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusRelativeOption(index, event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const enabledIndices = options
        .map((option, optionIndex) => option.disabled ? -1 : optionIndex)
        .filter((optionIndex) => optionIndex >= 0)
      const target = event.key === 'Home' ? enabledIndices[0] : enabledIndices[enabledIndices.length - 1]
      optionRefs.current[target]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeAndFocusTrigger()
    }
  }

  const handleBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    if (nextTarget instanceof Element && nextTarget.closest('[data-root-track-select-menu]')) return
    setOpen(false)
  }

  const menu = open && menuPosition ? createPortal(
    <div
      ref={menuRef}
      id={listboxId}
      className="root-track-select-menu"
      role="listbox"
      aria-label={ariaLabel}
      data-root-track-select-menu
      style={{
        left: menuPosition.left,
        top: menuPosition.top,
        width: menuPosition.width,
        maxHeight: menuPosition.maxHeight
      }}
      onPointerDown={(event) => event.preventDefault()}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => { optionRefs.current[index] = element }}
          type="button"
          className="root-track-select-option"
          role="option"
          aria-selected={option.value === value}
          disabled={option.disabled}
          onClick={() => {
            if (option.disabled) return
            closeAndFocusTrigger()
            onChange(option.value)
          }}
          onKeyDown={(event) => handleOptionKeyDown(event, index)}
        >
          <span>{option.label}</span>
          {option.value === value && (
            <svg width="11" height="9" viewBox="0 0 11 9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m1.5 4.5 2.5 2.5 5.5-5.5" />
            </svg>
          )}
        </button>
      ))}
    </div>,
    document.body
  ) : null

  return (
    <div className={`root-track-select ${className}`.trim()} onBlur={handleBlur}>
      <button
        ref={triggerRef}
        type="button"
        className="root-track-select-trigger"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onPointerDown={(event) => {
          // Keep pointer-opened menus anchored to the dialog's current focus.
          // The menu is portaled to <body>, so allowing the trigger to take
          // focus can otherwise look like focus left the parent popover.
          event.preventDefault()
          pendingKeyboardFocus.current = null
        }}
        onClick={() => {
          if (open) {
            setOpen(false)
          } else {
            setMenuPosition(null)
            setOpen(true)
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const direction = event.key === 'ArrowDown' ? 'first' : 'last'
            if (open) {
              const enabledIndices = options
                .map((option, index) => option.disabled ? -1 : index)
                .filter((index) => index >= 0)
              const target = direction === 'first' ? enabledIndices[0] : enabledIndices[enabledIndices.length - 1]
              optionRefs.current[target]?.focus()
            } else {
              pendingKeyboardFocus.current = direction
              setMenuPosition(null)
              setOpen(true)
            }
          } else if ((event.key === 'Enter' || event.key === ' ') && !open) {
            pendingKeyboardFocus.current = 'selected'
          } else if (event.key === 'Escape' && open) {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
          }
        }}
      >
        <span>{selectedOption?.label ?? placeholder}</span>
        <ChevronIcon open={open} />
      </button>
      {menu}
    </div>
  )
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
  const [columnDropTarget, setColumnDropTarget] = useState<RootTrackColumnId | null>(null)
  const [draggedSortIndex, setDraggedSortIndex] = useState<number | null>(null)
  const [sortDropTarget, setSortDropTarget] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const sortTriggerRef = useRef<HTMLButtonElement | null>(null)
  const columnsTriggerRef = useRef<HTMLButtonElement | null>(null)
  const sortPanelRef = useRef<HTMLDivElement | null>(null)
  const columnsPanelRef = useRef<HTMLDivElement | null>(null)
  const blurFrameRef = useRef<number | null>(null)
  const normalizedLayout = useMemo(() => normalizeRootTrackTableLayout(layout), [layout])
  const normalizedSortRules = useMemo(
    () => normalizeTrackSortRules(sortRules, { ratingsEnabled }),
    [ratingsEnabled, sortRules]
  )
  const displayedColumns = useMemo(() => normalizedLayout.columns.filter((entry) => (
    entry.id !== 'rating' || ratingsEnabled
  )), [normalizedLayout, ratingsEnabled])
  const availableSortColumns = displayedColumns
  const responsiveHiddenSet = useMemo(() => new Set(responsiveHiddenColumns), [responsiveHiddenColumns])
  const defaultLayout = useMemo(
    () => createDefaultRootTrackTableLayout({ showRating: ratingsEnabled }),
    [ratingsEnabled]
  )
  const isDefaultLayout = layoutsMatch(normalizedLayout, defaultLayout)
  const isDefaultSort = normalizedSortRules.length === 1
    && normalizedSortRules[0]?.key === 'title'
    && normalizedSortRules[0]?.direction === 'asc'
  const usedSortColumns = new Set(normalizedSortRules.map((rule) => rule.key))
  const unusedSortColumns = availableSortColumns.filter((entry) => !usedSortColumns.has(entry.id))
  const primarySort = normalizedSortRules[0]
  const primarySortLabel = ROOT_TRACK_COLUMN_LABELS[primarySort?.key ?? 'title']

  useEffect(() => {
    if (!openPanel) return
    const panel = openPanel === 'sort' ? sortPanelRef.current : columnsPanelRef.current
    const trigger = openPanel === 'sort' ? sortTriggerRef.current : columnsTriggerRef.current
    const frameId = window.requestAnimationFrame(() => {
      panel?.focus()
    })
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      if (event.target instanceof Element && event.target.closest('[data-root-track-select-menu]')) return
      setOpenPanel(null)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpenPanel(null)
      window.requestAnimationFrame(() => trigger?.focus())
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frameId)
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [openPanel])

  useEffect(() => () => {
    if (blurFrameRef.current !== null) window.cancelAnimationFrame(blurFrameRef.current)
  }, [])

  const handleRootBlur = () => {
    if (blurFrameRef.current !== null) window.cancelAnimationFrame(blurFrameRef.current)
    blurFrameRef.current = window.requestAnimationFrame(() => {
      blurFrameRef.current = null
      const activeElement = document.activeElement
      if (activeElement instanceof Node && rootRef.current?.contains(activeElement)) return
      if (activeElement instanceof Element && activeElement.closest('[data-root-track-select-menu]')) return
      setOpenPanel(null)
    })
  }

  const commitLayout = (nextLayout: RootTrackTableLayout) => {
    onLayoutChange(normalizeRootTrackTableLayout(nextLayout))
  }

  const moveColumn = (columnId: RootTrackColumnId, delta: -1 | 1) => {
    const displayedIndex = displayedColumns.findIndex((entry) => entry.id === columnId)
    const targetEntry = displayedColumns[displayedIndex + delta]
    if (displayedIndex <= 0 || !targetEntry || targetEntry.id === 'title') return
    const from = normalizedLayout.columns.findIndex((entry) => entry.id === columnId)
    const to = normalizedLayout.columns.findIndex((entry) => entry.id === targetEntry.id)
    commitLayout({ columns: moveItem(normalizedLayout.columns, from, to) })
  }

  const dropColumnAt = (targetId: RootTrackColumnId) => {
    if (!draggedColumn || draggedColumn === targetId || draggedColumn === 'title' || targetId === 'title') return
    const from = normalizedLayout.columns.findIndex((entry) => entry.id === draggedColumn)
    const to = normalizedLayout.columns.findIndex((entry) => entry.id === targetId)
    if (from < 1 || to < 1) return
    commitLayout({ columns: moveItem(normalizedLayout.columns, from, to) })
    setDraggedColumn(null)
    setColumnDropTarget(null)
  }

  const updateSortRule = (index: number, patch: Partial<TrackSortRule>) => {
    const next = normalizedSortRules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule)
    onSortRulesChange(normalizeTrackSortRules(next, { ratingsEnabled }))
  }

  const moveSortRule = (index: number, delta: -1 | 1) => {
    const target = index + delta
    if (target < 0 || target >= normalizedSortRules.length) return
    onSortRulesChange(reorderTrackSortRules(normalizedSortRules, index, target))
  }

  const dropSortRuleAt = (targetIndex: number) => {
    if (draggedSortIndex === null || draggedSortIndex === targetIndex) return
    onSortRulesChange(reorderTrackSortRules(normalizedSortRules, draggedSortIndex, targetIndex))
    setDraggedSortIndex(null)
    setSortDropTarget(null)
  }

  const addSortRule = (columnId: RootTrackColumnId) => {
    if (usedSortColumns.has(columnId)) return
    onSortRulesChange([
      ...normalizedSortRules,
      { key: columnId, direction: getDefaultTrackSortDirection(columnId) }
    ])
  }

  const removeSortRule = (key: RootTrackColumnId) => {
    if (normalizedSortRules.length <= 1) return
    onSortRulesChange(normalizeTrackSortRules(
      normalizedSortRules.filter((rule) => rule.key !== key),
      { ratingsEnabled }
    ))
    window.requestAnimationFrame(() => sortPanelRef.current?.focus())
  }

  const responsiveHiddenCount = responsiveHiddenColumns.length

  return (
    <div className="root-track-table-controls" ref={rootRef} onBlur={handleRootBlur}>
      <button
        ref={sortTriggerRef}
        id="root-track-sort-trigger"
        type="button"
        className={`root-track-table-control-btn ${openPanel === 'sort' ? 'active' : ''}`}
        onClick={() => setOpenPanel((current) => current === 'sort' ? null : 'sort')}
        aria-expanded={openPanel === 'sort'}
        aria-haspopup="dialog"
        aria-controls="root-track-sort-panel"
        aria-label={`Sort: ${primarySortLabel}${normalizedSortRules.length > 1 ? `, ${normalizedSortRules.length} priorities` : ''}`}
      >
        <span>Sort: {primarySortLabel}</span>
        {normalizedSortRules.length > 1 && (
          <span className="root-track-table-control-count" aria-hidden="true">{normalizedSortRules.length}</span>
        )}
      </button>
      <button
        ref={columnsTriggerRef}
        id="root-track-columns-trigger"
        type="button"
        className={`root-track-table-control-btn ${openPanel === 'columns' ? 'active' : ''}`}
        onClick={() => setOpenPanel((current) => current === 'columns' ? null : 'columns')}
        aria-expanded={openPanel === 'columns'}
        aria-haspopup="dialog"
        aria-controls="root-track-columns-panel"
        aria-label={`Columns${responsiveHiddenCount > 0 ? `, ${responsiveHiddenCount} hidden at this width` : ''}`}
      >
        <span>Columns</span>
        {responsiveHiddenCount > 0 && (
          <span className="root-track-table-hidden-count" aria-hidden="true">{responsiveHiddenCount} hidden</span>
        )}
      </button>

      {openPanel === 'sort' && (
        <div
          ref={sortPanelRef}
          id="root-track-sort-panel"
          className="root-track-table-panel root-track-sort-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="root-track-sort-panel-title"
          tabIndex={-1}
        >
          <div className="root-track-table-panel-heading">
            <div>
              <strong id="root-track-sort-panel-title">Sort</strong>
              <span>Rules run from top to bottom.</span>
            </div>
          </div>
          <div className="root-track-sort-rules">
            {normalizedSortRules.map((rule, index) => {
              const dropClass = sortDropTarget === index && draggedSortIndex !== null
                ? (draggedSortIndex < index ? ' is-drop-after' : ' is-drop-before')
                : ''
              return (
                <div
                  className={`root-track-sort-rule${draggedSortIndex === index ? ' is-dragging' : ''}${dropClass}`}
                  key={index}
                  onDragOver={(event) => {
                    if (draggedSortIndex === null) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    setSortDropTarget(index)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    dropSortRuleAt(index)
                  }}
                >
                  <span
                    className="root-track-drag-handle"
                    draggable
                    title={`Drag ${ROOT_TRACK_COLUMN_LABELS[rule.key]} to reorder`}
                    aria-hidden="true"
                    onDragStart={(event) => {
                      setDraggedSortIndex(index)
                      setSortDropTarget(null)
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', rule.key)
                    }}
                    onDragEnd={() => {
                      setDraggedSortIndex(null)
                      setSortDropTarget(null)
                    }}
                  >
                    <GripIcon />
                  </span>
                  <span className="root-track-rule-priority" aria-hidden="true">{index + 1}</span>
                  <div className="root-track-sort-control root-track-sort-field">
                    <span>{index === 0 ? 'Sort by' : 'Then by'}</span>
                    <TrackControlSelect
                      value={rule.key}
                      ariaLabel={`${index === 0 ? 'Sort by' : `Then by, priority ${index + 1}`} field`}
                      options={availableSortColumns.map((entry) => ({
                        value: entry.id,
                        label: ROOT_TRACK_COLUMN_LABELS[entry.id],
                        disabled: normalizedSortRules.some((candidate, candidateIndex) => (
                          candidateIndex !== index && candidate.key === entry.id
                        ))
                      }))}
                      onChange={(key) => {
                        updateSortRule(index, { key, direction: getDefaultTrackSortDirection(key) })
                      }}
                    />
                  </div>
                  <div className="root-track-sort-control root-track-sort-direction">
                    <span>Order</span>
                    <TrackControlSelect
                      value={rule.direction}
                      ariaLabel={`${ROOT_TRACK_COLUMN_LABELS[rule.key]} sort order`}
                      options={([
                        { value: 'asc', label: getTrackSortDirectionLabel(rule.key, 'asc') },
                        { value: 'desc', label: getTrackSortDirectionLabel(rule.key, 'desc') }
                      ] satisfies TrackControlSelectOption<TrackSortRule['direction']>[])}
                      onChange={(direction) => updateSortRule(index, { direction })}
                    />
                  </div>
                  <div className="root-track-row-actions root-track-reorder-actions" role="group" aria-label={`Reorder ${ROOT_TRACK_COLUMN_LABELS[rule.key]} sort`}>
                    <button type="button" onClick={() => moveSortRule(index, -1)} disabled={index === 0} aria-label={`Move ${ROOT_TRACK_COLUMN_LABELS[rule.key]} sort earlier`} title="Move earlier"><ArrowIcon direction="up" /></button>
                    <button type="button" onClick={() => moveSortRule(index, 1)} disabled={index === normalizedSortRules.length - 1} aria-label={`Move ${ROOT_TRACK_COLUMN_LABELS[rule.key]} sort later`} title="Move later"><ArrowIcon direction="down" /></button>
                  </div>
                  {normalizedSortRules.length > 1 && (
                    <button
                      type="button"
                      className="root-track-remove-rule"
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => removeSortRule(rule.key)}
                      aria-label={`Remove ${ROOT_TRACK_COLUMN_LABELS[rule.key]} sort`}
                      title="Remove sort"
                    >
                      <CloseIcon />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <div className="root-track-add-sort">
            <PlusIcon />
            <TrackControlSelect
              className="root-track-add-sort-select"
              value={null}
              disabled={unusedSortColumns.length === 0}
              placeholder="Add another sort"
              ariaLabel="Add another sort field"
              options={unusedSortColumns.map((entry) => ({
                value: entry.id,
                label: ROOT_TRACK_COLUMN_LABELS[entry.id]
              }))}
              onChange={addSortRule}
            />
          </div>
          <div className="root-track-table-panel-footer">
            <button
              type="button"
              onClick={() => onSortRulesChange([{ key: 'title', direction: 'asc' }])}
              disabled={isDefaultSort}
            >Reset to Title · A–Z</button>
          </div>
        </div>
      )}

      {openPanel === 'columns' && (
        <div
          ref={columnsPanelRef}
          id="root-track-columns-panel"
          className="root-track-table-panel root-track-columns-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="root-track-columns-panel-title"
          tabIndex={-1}
        >
          <div className="root-track-table-panel-heading">
            <div>
              <strong id="root-track-columns-panel-title">Columns</strong>
              <span>Choose columns and drag to reorder.</span>
            </div>
          </div>
          <div className="root-track-column-options">
            {displayedColumns.map((entry, index) => {
              const normalizedIndex = normalizedLayout.columns.findIndex((column) => column.id === entry.id)
              const draggedIndex = draggedColumn
                ? normalizedLayout.columns.findIndex((column) => column.id === draggedColumn)
                : -1
              const dropClass = columnDropTarget === entry.id && draggedIndex >= 0
                ? (draggedIndex < normalizedIndex ? ' is-drop-after' : ' is-drop-before')
                : ''
              const isResponsiveHidden = entry.visible && responsiveHiddenSet.has(entry.id)
              return (
                <div
                  className={`root-track-column-option${entry.visible ? '' : ' is-hidden'}${draggedColumn === entry.id ? ' is-dragging' : ''}${dropClass}`}
                  key={entry.id}
                  onDragOver={(event) => {
                    if (!draggedColumn || entry.id === 'title') return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    setColumnDropTarget(entry.id)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    dropColumnAt(entry.id)
                  }}
                >
                  {entry.id === 'title' ? (
                    <span className="root-track-column-anchor" aria-hidden="true" />
                  ) : (
                    <span
                      className="root-track-drag-handle"
                      draggable
                      title={`Drag ${ROOT_TRACK_COLUMN_LABELS[entry.id]} to reorder`}
                      aria-hidden="true"
                      onDragStart={(event) => {
                        setDraggedColumn(entry.id)
                        setColumnDropTarget(null)
                        event.dataTransfer.effectAllowed = 'move'
                        event.dataTransfer.setData('text/plain', entry.id)
                      }}
                      onDragEnd={() => {
                        setDraggedColumn(null)
                        setColumnDropTarget(null)
                      }}
                    >
                      <GripIcon />
                    </span>
                  )}
                  <span className="root-track-column-copy">
                    <strong>{ROOT_TRACK_COLUMN_LABELS[entry.id]}</strong>
                    {isResponsiveHidden && <small>Hidden at this width</small>}
                  </span>
                  {entry.id === 'title' ? (
                    <span className="root-track-column-pinned"><LockIcon />Pinned</span>
                  ) : (
                    <>
                      <div className="root-track-row-actions root-track-reorder-actions" role="group" aria-label={`Reorder ${ROOT_TRACK_COLUMN_LABELS[entry.id]} column`}>
                        <button type="button" onClick={() => moveColumn(entry.id, -1)} disabled={index <= 1} aria-label={`Move ${ROOT_TRACK_COLUMN_LABELS[entry.id]} column earlier`} title="Move earlier"><ArrowIcon direction="up" /></button>
                        <button type="button" onClick={() => moveColumn(entry.id, 1)} disabled={index === displayedColumns.length - 1} aria-label={`Move ${ROOT_TRACK_COLUMN_LABELS[entry.id]} column later`} title="Move later"><ArrowIcon direction="down" /></button>
                      </div>
                      <label className="root-track-column-visibility" title={`${entry.visible ? 'Hide' : 'Show'} ${ROOT_TRACK_COLUMN_LABELS[entry.id]} column`}>
                        <input
                          type="checkbox"
                          checked={entry.visible}
                          aria-label={`${ROOT_TRACK_COLUMN_LABELS[entry.id]} column`}
                          onChange={(event) => commitLayout({
                            columns: normalizedLayout.columns.map((column) => (
                              column.id === entry.id ? { ...column, visible: event.target.checked } : column
                            ))
                          })}
                        />
                        <span aria-hidden="true">
                          <svg width="11" height="9" viewBox="0 0 11 9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m1.5 4.5 2.5 2.5 5.5-5.5" />
                          </svg>
                        </span>
                      </label>
                    </>
                  )}
                </div>
              )
            })}
          </div>
          <div className="root-track-table-panel-footer">
            <button
              type="button"
              onClick={() => commitLayout(defaultLayout)}
              disabled={isDefaultLayout}
            >Reset to defaults</button>
          </div>
        </div>
      )}
    </div>
  )
}
