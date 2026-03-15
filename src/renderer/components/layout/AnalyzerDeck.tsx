import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import type { ScopeKind } from '../../../types/scopePopout'
import { useUIStore } from '../../stores/uiStore'
import { useVisualizerSettingsStore } from '../../stores/visualizerSettingsStore'
import VisualizerPanel from '../visualizers/VisualizerPanel'
import AnalyzerEditOverlay from './AnalyzerEditOverlay'

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
  const setScopeDeckLayout = useVisualizerSettingsStore((state) => state.setScopeDeckLayout)

  const [dragState, setDragState] = useState<ScopeEditDragState | null>(null)
  const [rackDropIndex, setRackDropIndex] = useState<number | null>(null)
  const [isHiddenDropActive, setIsHiddenDropActive] = useState(false)

  const visibleScopes = useMemo(() => {
    return scopeOrder.filter((scope) => !hiddenScopes.includes(scope))
  }, [hiddenScopes, scopeOrder])

  const hiddenOrderedScopes = useMemo(() => {
    return scopeOrder.filter((scope) => hiddenScopes.includes(scope))
  }, [hiddenScopes, scopeOrder])

  const resetDragState = useCallback(() => {
    setDragState(null)
    setRackDropIndex(null)
    setIsHiddenDropActive(false)
  }, [])

  useEffect(() => {
    if (!isAnalyzerEditMode) {
      resetDragState()
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
  }, [activeProfileId, resetDragState])

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
  }, [isAnalyzerEditMode, visibleScopes])

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
      <div className={`analyzer-brand-rail ${isAnalyzerEditMode ? 'is-editing' : ''}`.trim()}>
        <div className="analyzer-brand-dot" />
        <button
          type="button"
          className={`analyzer-rail-edit-btn ${isAnalyzerEditMode ? 'active' : ''}`.trim()}
          onClick={toggleAnalyzerEditMode}
          aria-pressed={isAnalyzerEditMode}
          aria-label={isAnalyzerEditMode ? 'Close scope editor' : 'Open scope editor'}
        >
          <svg
            className="analyzer-rail-edit-icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M4 7.5H13.5" />
            <path d="M4 12H20" />
            <path d="M10.5 16.5H20" />
            <circle cx="16.5" cy="7.5" r="1.6" />
            <circle cx="7.5" cy="16.5" r="1.6" />
          </svg>
        </button>
        <div className="analyzer-brand-label">SIGNAL PATH</div>
      </div>

      <div className="analyzer-visualizers">
        <VisualizerPanel
          isEditMode={isAnalyzerEditMode}
          draggedScope={dragState?.scope ?? null}
          rackDropIndex={rackDropIndex}
          onRackScopeDragStart={handleScopeDragStart}
          onRackScopeDragOver={handleRackDragOver}
          onRackScopeDrop={handleRackDrop}
          onRackScopeDragEnd={resetDragState}
          onRackEmptyDragOver={handleRackEmptyDragOver}
          onRackEmptyDrop={handleRackDrop}
        />
      </div>

      {isAnalyzerEditMode && (
        <AnalyzerEditOverlay
          hiddenScopes={hiddenOrderedScopes}
          draggedScope={dragState?.scope ?? null}
          isDraggingFromHidden={dragState?.fromHidden ?? false}
          isHiddenDropActive={isHiddenDropActive}
          onHiddenScopeDragStart={(scope, event) => handleScopeDragStart(scope, true, event)}
          onDragEnd={resetDragState}
          onHiddenDragOver={handleHiddenDragOver}
          onHiddenDrop={handleHiddenDrop}
        />
      )}
    </header>
  )
}
