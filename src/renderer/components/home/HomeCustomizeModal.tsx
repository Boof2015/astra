import { useEffect, useRef, useState, type DragEvent } from 'react'
import { usePresence } from '../../hooks/usePresence'
import { useListeningStatsStore } from '../../stores/listeningStatsStore'
import { useUIStore } from '../../stores/uiStore'
import type { HomeModuleId } from '../../utils/homePreferences'
import HomeSkyControls from './HomeSkyControls'

const MODULE_COPY: Record<HomeModuleId, { label: string; description: string }> = {
  'jump-back-in': { label: 'Jump Back In', description: 'Recent albums, playlists, and the active listening context.' },
  rediscover: { label: 'Rediscover', description: 'A transparent daily rotation from your own library.' },
  'pinned-playlists': { label: 'Pinned Playlists', description: 'The playlist shortcuts pinned to the sidebar.' },
  'recent-tracks': { label: 'Recently Played Tracks', description: 'Precise one-click replay for recent tracks.' },
  'newly-added': { label: 'Newly Added', description: 'The latest releases imported into Astra.' },
  'listening-snapshot': { label: 'Listening Snapshot', description: 'A compact summary from Listening Stats.' }
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
  const listeningStatsEnabled = useListeningStatsStore((state) => state.enabled)
  const [draggedModuleId, setDraggedModuleId] = useState<HomeModuleId | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!isOpen) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusableSelector = 'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
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
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    const frameId = window.requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>(focusableSelector)
      ;(first ?? dialogRef.current)?.focus()
    })
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frameId)
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [isOpen, onClose])

  if (!presence.shouldRender) return null
  const modules = layout.modules.filter((module) => module.id !== 'listening-snapshot' || listeningStatsEnabled)

  const handleDrop = (event: DragEvent<HTMLDivElement>, targetIndex: number) => {
    event.preventDefault()
    if (draggedModuleId) moveModule(draggedModuleId, targetIndex)
    setDraggedModuleId(null)
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
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <span className="home-customize-eyebrow">Listening launchpad</span>
            <h2 id="home-customize-title">Customize Home</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close Home customization">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
        <div className="modal-body home-customize-body">
          <section className="home-customize-section">
            <div className="home-customize-section-heading">
              <h3>Sky</h3>
              <p>Choose the atmosphere without changing Astra’s real clock.</p>
            </div>
            <HomeSkyControls compact />
          </section>

          <section className="home-customize-section">
            <div className="home-customize-section-heading">
              <h3>Sections</h3>
              <p>Show, hide, or reorder the shelves below the sky.</p>
            </div>
            <div className="home-customize-module-list">
              {modules.map((module, index) => {
                const copy = MODULE_COPY[module.id]
                return (
                  <div
                    key={module.id}
                    className={`home-customize-module${draggedModuleId === module.id ? ' is-dragging' : ''}`}
                    draggable
                    onDragStart={(event) => {
                      setDraggedModuleId(module.id)
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', module.id)
                    }}
                    onDragEnd={() => setDraggedModuleId(null)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => handleDrop(event, index)}
                  >
                    <span className="home-customize-grip" aria-hidden="true">⠿</span>
                    <span className="home-customize-module-copy">
                      <strong>{copy.label}</strong>
                      <span>{copy.description}</span>
                    </span>
                    <span className="home-customize-order-actions">
                      <button
                        type="button"
                        onClick={() => moveModule(module.id, index - 1)}
                        disabled={index === 0}
                        aria-label={`Move ${copy.label} up`}
                      >↑</button>
                      <button
                        type="button"
                        onClick={() => moveModule(module.id, index + 1)}
                        disabled={index === modules.length - 1}
                        aria-label={`Move ${copy.label} down`}
                      >↓</button>
                    </span>
                    <button
                      type="button"
                      className={`home-customize-visibility${module.visible ? ' is-on' : ''}`}
                      role="switch"
                      aria-checked={module.visible}
                      aria-label={`${module.visible ? 'Hide' : 'Show'} ${copy.label}`}
                      onClick={() => setVisible(module.id, !module.visible)}
                    >
                      <span />
                    </button>
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
              resetSky()
              resetLayout()
            }}
          >Reset Defaults</button>
          <button type="button" className="settings-btn settings-btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
