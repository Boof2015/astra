import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { ScopeKind } from '../../../types/scopePopout'
import { useAstraActivity } from '../../hooks/useAstraActivity'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { DEFAULT_ANALYZER_HEIGHT_PX, normalizeAnalyzerHeightPx, useUIStore } from '../../stores/uiStore'
import { useVisualizerSettingsStore } from '../../stores/visualizerSettingsStore'
import AstraActivityIndicator from '../activity/AstraActivityIndicator'
import VisualizerPanel from '../visualizers/VisualizerPanel'
import AnalyzerEditOverlay from './AnalyzerEditOverlay'
import { buildAnalyzerGridTemplateColumns } from './analyzerLayout'

interface AnalyzerDeckProps {
  onAnalyzerHeightPreviewChange?: (heightPx: number | null) => void
}

interface ScopeEditDragState {
  scope: ScopeKind
  fromHidden: boolean
}

interface HeightResizeSession {
  startClientY: number
  startHeightPx: number
}

const ANALYZER_RAIL_COLLAPSE_QUERY = '(max-width: 1040px)'

function AnalyzerBrandActivity() {
  const enabled = useUIStore((state) => state.activityIndicatorExperimentEnabled)
  const analyzerRailCollapsed = useMediaQuery(ANALYZER_RAIL_COLLAPSE_QUERY)
  if (!enabled || analyzerRailCollapsed) {
    return <div className="analyzer-brand-dot" />
  }

  return <AnalyzerBrandActivityIndicator />
}

function AnalyzerBrandActivityIndicator() {
  const activity = useAstraActivity()

  return (
    <AstraActivityIndicator
      className="analyzer-brand-activity"
      state={activity.state}
      event={activity.event}
      size={22}
    />
  )
}

export default function AnalyzerDeck({ onAnalyzerHeightPreviewChange }: AnalyzerDeckProps) {
  const isAnalyzerEditMode = useUIStore((state) => state.isAnalyzerEditMode)
  const toggleAnalyzerEditMode = useUIStore((state) => state.toggleAnalyzerEditMode)
  const analyzerHeightPx = useUIStore((state) => state.analyzerHeightPx)
  const setAnalyzerHeightPx = useUIStore((state) => state.setAnalyzerHeightPx)
  const resetAnalyzerHeightPx = useUIStore((state) => state.resetAnalyzerHeightPx)

  const activeProfileId = useVisualizerSettingsStore((state) => state.activeProfileId)
  const scopeOrder = useVisualizerSettingsStore((state) => state.scopeOrder)
  const hiddenScopes = useVisualizerSettingsStore((state) => state.hiddenScopes)
  const widthWeights = useVisualizerSettingsStore((state) => state.widthWeights)
  const vectorscopeMode = useVisualizerSettingsStore((state) => state.vectorscopeMode)
  const setScopeDeckLayout = useVisualizerSettingsStore((state) => state.setScopeDeckLayout)

  const [dragState, setDragState] = useState<ScopeEditDragState | null>(null)
  const [rackDropIndex, setRackDropIndex] = useState<number | null>(null)
  const [isHiddenDropActive, setIsHiddenDropActive] = useState(false)
  const [resizePreviewWeights, setResizePreviewWeights] = useState<Partial<Record<ScopeKind, number>> | null>(null)
  const [hoveredScope, setHoveredScope] = useState<ScopeKind | null>(null)
  const [pinnedScope, setPinnedScope] = useState<ScopeKind | null>(null)
  const [heightPreviewPx, setHeightPreviewPx] = useState<number | null>(null)
  const heightResizeSessionRef = useRef<HeightResizeSession | null>(null)
  const heightResizeCleanupRef = useRef<(() => void) | null>(null)
  const heightPreviewPxRef = useRef<number | null>(null)

  const visibleScopes = useMemo(() => {
    return scopeOrder.filter((scope) => !hiddenScopes.includes(scope))
  }, [hiddenScopes, scopeOrder])

  const hiddenOrderedScopes = useMemo(() => {
    return scopeOrder.filter((scope) => hiddenScopes.includes(scope))
  }, [hiddenScopes, scopeOrder])

  const effectiveWidthWeights = useMemo(() => {
    if (!resizePreviewWeights) return widthWeights
    return {
      ...widthWeights,
      ...resizePreviewWeights,
    }
  }, [resizePreviewWeights, widthWeights])

  const gridTemplateColumns = useMemo(() => {
    return buildAnalyzerGridTemplateColumns(visibleScopes, effectiveWidthWeights, vectorscopeMode)
  }, [effectiveWidthWeights, vectorscopeMode, visibleScopes])

  const activeScope = useMemo(() => {
    if (pinnedScope && visibleScopes.includes(pinnedScope)) return pinnedScope
    if (hoveredScope && visibleScopes.includes(hoveredScope)) return hoveredScope
    return visibleScopes[0] ?? null
  }, [hoveredScope, pinnedScope, visibleScopes])

  const resetDragState = useCallback(() => {
    setDragState(null)
    setRackDropIndex(null)
    setIsHiddenDropActive(false)
  }, [])

  useEffect(() => {
    heightPreviewPxRef.current = heightPreviewPx
    onAnalyzerHeightPreviewChange?.(heightPreviewPx)
  }, [heightPreviewPx, onAnalyzerHeightPreviewChange])

  const stopHeightResize = useCallback((commit: boolean) => {
    heightResizeCleanupRef.current?.()
    heightResizeCleanupRef.current = null

    const previewHeightPx = heightPreviewPxRef.current
    heightResizeSessionRef.current = null
    heightPreviewPxRef.current = null
    setHeightPreviewPx(null)

    if (commit && previewHeightPx !== null) {
      setAnalyzerHeightPx(previewHeightPx)
    }
  }, [setAnalyzerHeightPx])

  useEffect(() => {
    if (!isAnalyzerEditMode) {
      stopHeightResize(false)
      resetDragState()
      setResizePreviewWeights(null)
      setHoveredScope(null)
      setPinnedScope(null)
    }
  }, [isAnalyzerEditMode, resetDragState, stopHeightResize])

  useEffect(() => {
    if (!isAnalyzerEditMode) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        toggleAnalyzerEditMode()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isAnalyzerEditMode, toggleAnalyzerEditMode])

  useEffect(() => {
    resetDragState()
    setResizePreviewWeights(null)
    setHoveredScope(null)
    setPinnedScope(null)
  }, [activeProfileId, resetDragState])

  useEffect(() => {
    if (hoveredScope && !visibleScopes.includes(hoveredScope)) {
      setHoveredScope(null)
    }
    if (pinnedScope && !visibleScopes.includes(pinnedScope)) {
      setPinnedScope(null)
    }
  }, [hoveredScope, pinnedScope, visibleScopes])

  const commitDeckLayout = useCallback((nextVisibleScopes: ScopeKind[], nextHiddenScopes: ScopeKind[]) => {
    const nextOrder = [...nextVisibleScopes, ...nextHiddenScopes]
    setScopeDeckLayout(nextOrder, nextHiddenScopes)
  }, [setScopeDeckLayout])

  const handleScopeDragStart = useCallback((scope: ScopeKind, fromHidden: boolean, event: DragEvent<HTMLDivElement>) => {
    if (!isAnalyzerEditMode) {
      event.preventDefault()
      return
    }

    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', scope)
    setDragState({ scope, fromHidden })
    setRackDropIndex(fromHidden ? visibleScopes.length : visibleScopes.indexOf(scope))
    setIsHiddenDropActive(false)
    setHoveredScope(scope)
  }, [isAnalyzerEditMode, visibleScopes])

  const handleScopeActivate = useCallback((scope: ScopeKind) => {
    setHoveredScope(scope)
    setPinnedScope((current) => current === scope ? null : scope)
  }, [])

  const handleRackDragOver = useCallback((index: number, event: DragEvent<HTMLDivElement>) => {
    if (!dragState) return

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'

    const rect = event.currentTarget.getBoundingClientRect()
    const targetIndex = event.clientX < rect.left + (rect.width / 2)
      ? index
      : index + 1

    setRackDropIndex(targetIndex)
    setIsHiddenDropActive(false)
  }, [dragState])

  const handleRackEmptyDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragState) return

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setRackDropIndex(0)
    setIsHiddenDropActive(false)
  }, [dragState])

  const handleRackDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragState || rackDropIndex === null) {
      resetDragState()
      return
    }

    event.preventDefault()

    const originalIndex = dragState.fromHidden ? -1 : visibleScopes.indexOf(dragState.scope)
    const nextVisibleScopes = visibleScopes.filter((scope) => scope !== dragState.scope)
    const nextHiddenScopes = hiddenOrderedScopes.filter((scope) => scope !== dragState.scope)
    const adjustedIndex = originalIndex !== -1 && originalIndex < rackDropIndex
      ? rackDropIndex - 1
      : rackDropIndex
    const clampedIndex = Math.max(0, Math.min(adjustedIndex, nextVisibleScopes.length))

    nextVisibleScopes.splice(clampedIndex, 0, dragState.scope)
    commitDeckLayout(nextVisibleScopes, nextHiddenScopes)
    resetDragState()
  }, [
    commitDeckLayout,
    dragState,
    hiddenOrderedScopes,
    rackDropIndex,
    resetDragState,
    visibleScopes,
  ])

  const handleHiddenDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragState) return

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setRackDropIndex(null)
    setIsHiddenDropActive(true)
  }, [dragState])

  const handleHiddenDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragState) {
      resetDragState()
      return
    }

    event.preventDefault()

    if (dragState.fromHidden) {
      resetDragState()
      return
    }

    const nextVisibleScopes = visibleScopes.filter((scope) => scope !== dragState.scope)
    const nextHiddenScopes = [...hiddenOrderedScopes.filter((scope) => scope !== dragState.scope), dragState.scope]

    commitDeckLayout(nextVisibleScopes, nextHiddenScopes)
    resetDragState()
  }, [commitDeckLayout, dragState, hiddenOrderedScopes, resetDragState, visibleScopes])

  const startHeightResizeDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!isAnalyzerEditMode) return

    event.preventDefault()
    event.stopPropagation()

    heightResizeSessionRef.current = {
      startClientY: event.clientY,
      startHeightPx: heightPreviewPxRef.current ?? analyzerHeightPx,
    }

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const session = heightResizeSessionRef.current
      if (!session) return

      const nextHeightPx = normalizeAnalyzerHeightPx(
        session.startHeightPx + (moveEvent.clientY - session.startClientY)
      )

      heightPreviewPxRef.current = nextHeightPx
      setHeightPreviewPx((current) => current === nextHeightPx ? current : nextHeightPx)
    }

    const handlePointerUp = () => {
      stopHeightResize(true)
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }

    heightResizeCleanupRef.current = cleanup
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
  }, [analyzerHeightPx, isAnalyzerEditMode, stopHeightResize])

  const handleHeightReset = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    stopHeightResize(false)
    resetAnalyzerHeightPx()
  }, [resetAnalyzerHeightPx, stopHeightResize])

  return (
    <header className="analyzer-deck">
      <button
        type="button"
        className={`analyzer-brand-rail ${isAnalyzerEditMode ? 'is-editing' : ''}`.trim()}
        onClick={toggleAnalyzerEditMode}
        aria-pressed={isAnalyzerEditMode}
        aria-label={isAnalyzerEditMode ? 'Close scope editor' : 'Open scope editor'}
        title={isAnalyzerEditMode ? 'Close scope editor' : 'Open scope editor'}
      >
        <AnalyzerBrandActivity />
        <div
          className={`analyzer-brand-label analyzer-brand-label-btn ${isAnalyzerEditMode ? 'active' : ''}`.trim()}
        >
          {isAnalyzerEditMode ? 'DONE' : 'EDIT'}
        </div>
      </button>

      <div className="analyzer-visualizers">
        <VisualizerPanel
          visibleScopes={visibleScopes}
          gridTemplateColumns={gridTemplateColumns}
          isEditMode={isAnalyzerEditMode}
          draggedScope={dragState?.scope ?? null}
          highlightedScope={activeScope}
          rackDropIndex={rackDropIndex}
          onRackScopeDragStart={handleScopeDragStart}
          onRackScopeDragOver={handleRackDragOver}
          onRackScopeDrop={handleRackDrop}
          onRackScopeDragEnd={resetDragState}
          onRackEmptyDragOver={handleRackEmptyDragOver}
          onRackEmptyDrop={handleRackDrop}
          onScopeHoverChange={setHoveredScope}
          onScopeActivate={handleScopeActivate}
          onResizePreviewChange={setResizePreviewWeights}
        />
      </div>

      {isAnalyzerEditMode && (
        <AnalyzerEditOverlay
          visibleScopes={visibleScopes}
          hiddenScopes={hiddenOrderedScopes}
          gridTemplateColumns={gridTemplateColumns}
          activeScope={activeScope}
          isScopePinned={activeScope !== null && pinnedScope === activeScope}
          draggedScope={dragState?.scope ?? null}
          isDraggingFromHidden={dragState?.fromHidden ?? false}
          isHiddenDropActive={isHiddenDropActive}
          onHiddenScopeDragStart={(scope, event) => handleScopeDragStart(scope, true, event)}
          onDragEnd={resetDragState}
          onHiddenDragOver={handleHiddenDragOver}
          onHiddenDrop={handleHiddenDrop}
          onScopeHoverChange={setHoveredScope}
        />
      )}

      {isAnalyzerEditMode && (
        <button
          type="button"
          className="analyzer-deck-height-seam"
          onPointerDown={startHeightResizeDrag}
          onDoubleClick={handleHeightReset}
          aria-label={`Resize analyzer rack height. Double-click to reset to ${DEFAULT_ANALYZER_HEIGHT_PX}px.`}
        >
          <span className="analyzer-deck-height-seam-line" aria-hidden="true" />
          <span className="analyzer-deck-height-seam-grip" aria-hidden="true" />
        </button>
      )}
    </header>
  )
}
