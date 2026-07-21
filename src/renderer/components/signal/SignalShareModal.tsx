import { useEffect, useMemo, useRef, useState } from 'react'
import { usePresence } from '../../hooks/usePresence'
import { useUIStore } from '../../stores/uiStore'
import { buildSignalShareModel } from '../../utils/signalShare'
import {
  renderSignalShareCanvas,
  signalShareCanvasToPng
} from '../../utils/signalShareCanvas'

type SignalShareAction = 'link' | 'copy' | 'save'

export default function SignalShareModal() {
  const target = useUIStore((state) => state.signalShareTarget)
  const closeSignalShare = useUIStore((state) => state.closeSignalShare)
  const presence = usePresence(target)
  const displayedTarget = presence.presentValue
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [previewReady, setPreviewReady] = useState(false)
  const [busyAction, setBusyAction] = useState<SignalShareAction | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const generated = useMemo(() => {
    if (!displayedTarget) return { model: null, error: null }
    try {
      return { model: buildSignalShareModel(displayedTarget), error: null }
    } catch (error) {
      return {
        model: null,
        error: error instanceof Error ? error.message : 'This track could not be encoded as an Astra Signal.'
      }
    }
  }, [displayedTarget])

  useEffect(() => {
    if (!target) return
    setPreviewReady(false)
    setBusyAction(null)
    setStatusMessage(null)
    setErrorMessage(null)
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus())
    return () => window.cancelAnimationFrame(focusFrame)
  }, [target])

  useEffect(() => {
    if (!target) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeSignalShare()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeSignalShare, target])

  useEffect(() => {
    if (!generated.model || !canvasRef.current) return
    try {
      renderSignalShareCanvas(canvasRef.current, generated.model.layout)
      setPreviewReady(true)
    } catch (error) {
      setPreviewReady(false)
      setErrorMessage(error instanceof Error ? error.message : 'The Signal preview could not be rendered.')
    }
  }, [generated.model])

  if (!presence.shouldRender || !displayedTarget) return null

  const model = generated.model

  const runAction = async (action: SignalShareAction) => {
    if (!model || busyAction) return
    setBusyAction(action)
    setStatusMessage(null)
    setErrorMessage(null)
    try {
      if (action === 'link') {
        await navigator.clipboard.writeText(model.webUrl)
        setStatusMessage('Copied the Signal link.')
        return
      }

      const canvas = canvasRef.current
      if (!canvas || !previewReady) throw new Error('The Signal image is not ready yet.')
      const bytes = await signalShareCanvasToPng(canvas)
      if (action === 'copy') {
        const copied = await window.electronAPI.signalShare.copyPng(bytes)
        if (!copied) throw new Error('The Signal image could not be copied.')
        setStatusMessage('Copied the Signal image.')
        return
      }

      const savedPath = await window.electronAPI.signalShare.savePng(bytes, model.suggestedFileName)
      if (savedPath) setStatusMessage('Saved the Signal PNG.')
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : `The Signal could not be ${action === 'save' ? 'saved' : 'copied'}.`
      )
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <div
      className="modal-overlay signal-share-overlay"
      data-presence={presence.phase}
      aria-hidden={presence.phase === 'exiting'}
      onClick={closeSignalShare}
    >
      <div
        className="modal-content signal-share-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="signal-share-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header signal-share-header">
          <div className="signal-share-heading">
            <p>ASTRA SIGNAL • V3</p>
            <h2 id="signal-share-title">Create Astra Signal</h2>
          </div>
          <button
            ref={closeButtonRef}
            className="modal-close"
            type="button"
            onClick={closeSignalShare}
            aria-label="Close Astra Signal"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="modal-body signal-share-body">
          <div className="signal-share-track">
            <strong title={displayedTarget.title}>{displayedTarget.title || 'Untitled track'}</strong>
            <span title={displayedTarget.artist}>{displayedTarget.artist || 'Unknown artist'}</span>
          </div>

          {model ? (
            <div className="signal-share-preview-shell">
              <canvas
                ref={canvasRef}
                className="signal-share-canvas"
                role="img"
                aria-label={`Astra Signal for ${model.layout.payload.title} by ${model.layout.payload.artist}`}
              />
            </div>
          ) : (
            <div className="signal-share-generation-error" role="alert">
              {generated.error ?? 'This track could not be encoded as an Astra Signal.'}
            </div>
          )}

          <p className="signal-share-guidance">
            Keep the complete light card visible when scanning it with another device.
          </p>

          {model?.metadataWasShortened && (
            <div className="signal-share-warning" role="status">
              <strong>Metadata shortened to fit Signal v3</strong>
              <span>{model.layout.payload.title || 'Untitled track'} — {model.layout.payload.artist || 'Unknown artist'}</span>
            </div>
          )}

          {(statusMessage || errorMessage) && (
            <p
              className={`signal-share-message ${errorMessage ? 'is-error' : 'is-success'}`}
              role={errorMessage ? 'alert' : 'status'}
            >
              {errorMessage ?? statusMessage}
            </p>
          )}
        </div>

        <div className="modal-footer signal-share-footer">
          <button
            className="settings-btn"
            type="button"
            disabled={!model || busyAction !== null}
            onClick={() => void runAction('link')}
          >
            {busyAction === 'link' ? 'Copying…' : 'Copy Link'}
          </button>
          <button
            className="settings-btn"
            type="button"
            disabled={!model || !previewReady || busyAction !== null}
            onClick={() => void runAction('copy')}
          >
            {busyAction === 'copy' ? 'Copying…' : 'Copy Image'}
          </button>
          <button
            className="settings-btn settings-btn-primary"
            type="button"
            disabled={!model || !previewReady || busyAction !== null}
            onClick={() => void runAction('save')}
          >
            {busyAction === 'save' ? 'Saving…' : 'Save PNG'}
          </button>
        </div>
      </div>
    </div>
  )
}
