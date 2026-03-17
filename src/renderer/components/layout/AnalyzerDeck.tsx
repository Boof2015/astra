import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import type { ScopeKind } from '../../../types/scopePopout'
import { useUIStore } from '../../stores/uiStore'
import { useVisualizerSettingsStore } from '../../stores/visualizerSettingsStore'
import VisualizerPanel from '../visualizers/VisualizerPanel'
import AnalyzerEditOverlay from './AnalyzerEditOverlay'
import { buildAnalyzerGridTemplateColumns } from './analyzerLayout'

interface ScopeEditDragState {
  scope: ScopeKind
  fromHidden: boolean
}

export default function AnalyzerDeck() {
  const isAnalyzerEditMode = useUIStore((state) => state.isAnalyzerEditMode)
  const toggleAnalyzerEditMode = useUIStore((state) => state.toggleAnalyzerEditMode)

  const activeProfileId = useVisualizerSettingsStore((state) => state.activeProfileId)
  const scopeOrder = useVisualizerSettingsStore((state) => state.scopeOrder)
  const hiddenScopes = useVisualizerSettingsStore((state) => state.hiddenScopes)
  const widthWeights = useVisualizerSettingsStore((state) => state.widthWeights)
  const setScopeDeckLayout = useVisualizerSettingsStore((state) => state.setScopeDeckLayout)

  const [dragState, setDragState] = useState<ScopeEditDragState | null>(null)
  const [rackDropIndex, setRackDropIndex] = useState<number | null>(null)
  const [isHiddenDropActive, setIsHiddenDropActive] = useState(false)
  const [resizePreviewWeights, setResizePreviewWeights] = useState<Partial<Record<ScopeKind, number>> | null>(null)
  const [hoveredScope, setHoveredScope] = useState<ScopeKind | null>(null)
  const [pinnedScope, setPinnedScope] = useState<ScopeKind | null>(null)

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
    return buildAnalyzerGridTemplateColumns(visibleScopes, effectiveWidthWeights)
  }, [effectiveWidthWeights, visibleScopes])

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
    if (!isAnalyzerEditMode) {
      resetDragState()
      setResizePreviewWeights(null)
      setHoveredScope(null)
      setPinnedScope(null)
    }
  }, [isAnalyzerEditMode, resetDragState])

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

  return (
    <header className="analyzer-deck">
      <button
        type="button"
        className={`analyzer-brand-rail ${isAnalyzerEditMode ? 'is-editing' : ''}`.trim()}
        onClick={toggleAnalyzerEditMode}
        aria-pressed={isAnalyzerEditMode}
        aria-label={isAnalyzerEditMode ? 'Close scope editor' : 'Open scope editor'}
      >
        <div className="analyzer-brand-dot" />
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
    </header>
  )
}
