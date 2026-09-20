import { useEffect, useRef, useState } from 'react'
import { usePresence } from '../../hooks/usePresence'
import { useListeningStatsStore } from '../../stores/listeningStatsStore'
import { useUIStore } from '../../stores/uiStore'
import type { HomeModuleId } from '../../utils/homePreferences'
import HomeHeaderControls from './HomeHeaderControls'
import HomeSkyControls from './HomeSkyControls'

const MODULE_COPY: Record<HomeModuleId, { label: string; description: string }> = {
  'jump-back-in': { label: 'Jump Back In', description: 'Return to recent albums and playlists.' },
  rediscover: { label: 'Rediscover', description: 'A daily selection from your library.' },
  'pinned-playlists': { label: 'Pinned Playlists', description: 'Your pinned playlist shortcuts.' },
  'recent-tracks': { label: 'Recently Played Tracks', description: 'Replay your recent tracks.' },
  'newly-added': { label: 'Newly Added', description: 'The latest additions to your library.' },
  'listening-snapshot': { label: 'Listening Snapshot', description: 'Your listening at a glance.' }
}

function GripIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
      <circle cx="4" cy="3" r="1" /><circle cx="10" cy="3" r="1" />
      <circle cx="4" cy="7" r="1" /><circle cx="10" cy="7" r="1" />
      <circle cx="4" cy="11" r="1" /><circle cx="10" cy="11" r="1" />
    </svg>
  )
}

function ArrowIcon({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={direction === 'up' ? 'M8 13V3m-3.5 3.5L8 3l3.5 3.5' : 'M8 3v10m-3.5-3.5L8 13l3.5-3.5'} />
    </svg>
  )
}

interface HomeCustomizeModalProps {
  isOpen: boolean
  onClose: () => void
}

export default function HomeCustomizeModal({ isOpen, onClose }: HomeCustomizeModalProps) {
  const presence = usePresence(isOpen)
  const layout = useUIStore((state) => state.homeLayoutPreference)
  const setVisible = useUIStore((state) => state.setHomeModuleVisible)
  const moveModule = useUIStore((state) => state.moveHomeModule)
  const resetLayout = useUIStore((state) => state.resetHomeLayoutPreference)
  const resetSky = useUIStore((state) => state.resetHomeSkyTimePreference)
  const resetHeader = useUIStore((state) => state.resetHomeGreetingTextMode)
  const listeningStatsEnabled = useListeningStatsStore((state) => state.enabled)
  const [draggedModuleId, setDraggedModuleId] = useState<HomeModuleId | null>(null)
  const [dropTargetId, setDropTargetId] = useState<HomeModuleId | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!isOpen) {
      setDraggedModuleId(null)
      setDropTargetId(null)
      return
    }
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusableSelector = 'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector))
      if (!focusable.length) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (document.activeElement === dialogRef.current || !dialogRef.current.contains(document.activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    const frameId = window.requestAnimationFrame(() => {
      dialogRef.current?.focus()
    })
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frameId)
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [isOpen])

  if (!presence.shouldRender) return null
  const modules = layout.modules.filter((module) => module.id !== 'listening-snapshot' || listeningStatsEnabled)

  const moveModuleTo = (moduleId: HomeModuleId, targetId: HomeModuleId | undefined) => {
    if (!targetId || moduleId === targetId) return
    // Displayed indices differ from stored indices when Listening Snapshot is unavailable.
    const targetIndex = layout.modules.findIndex((module) => module.id === targetId)
    if (targetIndex >= 0) moveModule(moduleId, targetIndex)
  }

  const clearDrag = () => {
    setDraggedModuleId(null)
    setDropTargetId(null)
  }

  return (
    <div
      className="modal-overlay"
      data-presence={presence.phase}
      aria-hidden={presence.phase === 'exiting'}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="modal-content home-customize-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="home-customize-title"
        aria-describedby="home-customize-description"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 id="home-customize-title">Customize Home</h2>
            <p id="home-customize-description">Make Home yours.</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close Home customization">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div className="modal-body home-customize-body">
          <section className="home-customize-section">
            <div className="home-customize-section-heading">
              <h3>Header</h3>
            </div>
            <HomeHeaderControls compact />
          </section>

          <section className="home-customize-section">
            <div className="home-customize-section-heading">
              <h3>Sky</h3>
            </div>
            <HomeSkyControls compact />
          </section>

          <section className="home-customize-section">
            <div className="home-customize-section-heading">
              <h3>Sections</h3>
              <p>Choose sections and drag to reorder.</p>
            </div>
            <div className="home-customize-module-list">
              {modules.map((module, index) => {
                const copy = MODULE_COPY[module.id]
                const draggedIndex = modules.findIndex((entry) => entry.id === draggedModuleId)
                const dropClass = dropTargetId === module.id && draggedIndex >= 0 && draggedIndex !== index
                  ? (draggedIndex < index ? ' is-drop-after' : ' is-drop-before')
                  : ''
                return (
                  <div
                    key={module.id}
                    className={`home-customize-module${module.visible ? '' : ' is-hidden'}${draggedModuleId === module.id ? ' is-dragging' : ''}${dropClass}`}
                    onDragOver={(event) => {
                      if (!draggedModuleId) return
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                      setDropTargetId(module.id)
                    }}
                    onDragLeave={(event) => {
                      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                        setDropTargetId(null)
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      if (draggedModuleId) moveModuleTo(draggedModuleId, module.id)
                      clearDrag()
                    }}
                  >
                    <span
                      className="home-customize-grip"
                      draggable
                      title={`Drag ${copy.label} to reorder`}
                      aria-hidden="true"
                      onDragStart={(event) => {
                        setDraggedModuleId(module.id)
                        setDropTargetId(null)
                        event.dataTransfer.effectAllowed = 'move'
                        event.dataTransfer.setData('text/plain', module.id)
                      }}
                      onDragEnd={clearDrag}
                    ><GripIcon /></span>
                    <span className="home-customize-module-copy">
                      <strong>{copy.label}</strong>
                      <span id={`home-customize-${module.id}-description`}>{copy.description}</span>
                    </span>
                    <span className="home-customize-order-actions" role="group" aria-label={`Reorder ${copy.label}`}>
                      <button
                        type="button"
                        onClick={() => moveModuleTo(module.id, modules[index - 1]?.id)}
                        disabled={index === 0}
                        aria-label={`Move ${copy.label} up`}
                        title="Move up"
                      ><ArrowIcon direction="up" /></button>
                      <button
                        type="button"
                        onClick={() => moveModuleTo(module.id, modules[index + 1]?.id)}
                        disabled={index === modules.length - 1}
                        aria-label={`Move ${copy.label} down`}
                        title="Move down"
                      ><ArrowIcon direction="down" /></button>
                    </span>
                    <label className="home-customize-visibility" title={`${module.visible ? 'Hide' : 'Show'} ${copy.label}`}>
                      <input
                        type="checkbox"
                        checked={module.visible}
                        aria-label={`${copy.label} section`}
                        aria-describedby={`home-customize-${module.id}-description`}
                        onChange={(event) => setVisible(module.id, event.target.checked)}
                      />
                      <span aria-hidden="true">
                        <svg width="11" height="9" viewBox="0 0 11 9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m1.5 4.5 2.5 2.5 5.5-5.5" />
                        </svg>
                      </span>
                    </label>
                  </div>
                )
              })}
            </div>
          </section>
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="settings-btn"
            onClick={() => {
              resetHeader()
              resetSky()
              resetLayout()
            }}
          >Reset to defaults</button>
          <button type="button" className="settings-btn settings-btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
