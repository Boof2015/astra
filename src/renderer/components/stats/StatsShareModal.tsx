import { useEffect, useMemo, useRef, useState } from 'react'
import type { ListeningStatsDashboard } from '../../../types/listeningStats'
import astraWordmarkUrl from '../../assets/astra-wordmark.svg'
import { usePresence } from '../../hooks/usePresence'
import { useLibraryStore } from '../../stores/libraryStore'
import { createAstraLogoSvgDataUrl } from '../icons/astraLogoShared'
import {
  buildListeningStatsShareModel,
  type ListeningStatsShareLens
} from '../../utils/listeningStatsShare'
import {
  LISTENING_STATS_SHARE_HEIGHT,
  LISTENING_STATS_SHARE_WIDTH,
  listeningStatsShareCanvasToPng,
  loadListeningStatsShareImage,
  renderListeningStatsShareCard
} from '../../utils/listeningStatsShareCanvas'

interface StatsShareModalProps {
  isOpen: boolean
  snapshot: ListeningStatsDashboard | null
  onClose: () => void
}

const LENS_OPTIONS: Array<{ value: ListeningStatsShareLens; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'track', label: 'Track' },
  { value: 'album', label: 'Album' }
]

function shareAccentColor(): string {
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  return accent || '#38bdf8'
}

export default function StatsShareModal({ isOpen, snapshot, onClose }: StatsShareModalProps) {
  const presence = usePresence(isOpen && snapshot ? snapshot : null)
  const displayedSnapshot = presence.presentValue
  const [lens, setLens] = useState<ListeningStatsShareLens>('overview')
  const [isPreparing, setIsPreparing] = useState(false)
  const [busyAction, setBusyAction] = useState<'copy' | 'save' | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const getArtwork = useLibraryStore((state) => state.getArtwork)

  const model = useMemo(
    () => displayedSnapshot ? buildListeningStatsShareModel(displayedSnapshot, lens) : null,
    [displayedSnapshot, lens]
  )

  useEffect(() => {
    if (!isOpen) return
    setLens('overview')
    setStatusMessage(null)
    setErrorMessage(null)
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus())
    return () => window.cancelAnimationFrame(focusFrame)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  useEffect(() => {
    if (!model || !canvasRef.current) return
    let cancelled = false
    setIsPreparing(true)
    setStatusMessage(null)
    setErrorMessage(null)

    const render = async () => {
      if (document.fonts) {
        await Promise.all([
          document.fonts.load('700 58px Inter'),
          document.fonts.load('600 38px "JetBrains Mono"'),
          document.fonts.ready
        ])
      }
      const accentColor = shareAccentColor()
      const logoDataUrl = createAstraLogoSvgDataUrl({
        includeBackground: false,
        mainFill: accentColor,
        shadowFill: '#14202a'
      })
      const [astraLogo, astraWordmark] = await Promise.all([
        loadListeningStatsShareImage(logoDataUrl).catch(() => null),
        loadListeningStatsShareImage(astraWordmarkUrl).catch(() => null)
      ])
      const artworkEntries = await Promise.all(model.artworkHashes.map(async (hash) => {
        const dataUrl = await getArtwork(hash, { variant: 'full', format: 'data-url' })
        if (!dataUrl) return [hash, null] as const
        const image = await loadListeningStatsShareImage(dataUrl).catch(() => null)
        return [hash, image] as const
      }))
      if (cancelled || !canvasRef.current) return
      renderListeningStatsShareCard(canvasRef.current, model, {
        accentColor,
        artworkByHash: new Map(artworkEntries.filter((entry): entry is readonly [string, HTMLImageElement] => entry[1] !== null)),
        astraLogo,
        astraWordmark
      })
      setIsPreparing(false)
    }

    void render().catch((error) => {
      if (cancelled) return
      setIsPreparing(false)
      setErrorMessage(error instanceof Error ? error.message : 'The share-card preview could not be created.')
    })
    return () => {
      cancelled = true
    }
  }, [getArtwork, model])

  if (!presence.shouldRender || !displayedSnapshot || !model) return null

  const exportPng = async (action: 'copy' | 'save') => {
    const canvas = canvasRef.current
    if (!canvas || isPreparing || busyAction) return
    setBusyAction(action)
    setStatusMessage(null)
    setErrorMessage(null)
    try {
      const bytes = await listeningStatsShareCanvasToPng(canvas)
      if (action === 'copy') {
        const copied = await window.electronAPI.statsShare.copyPng(bytes)
        if (!copied) throw new Error('The image could not be copied to the clipboard.')
        setStatusMessage('Copied PNG to the clipboard.')
      } else {
        const savedPath = await window.electronAPI.statsShare.savePng(bytes, model.suggestedFileName)
        if (savedPath) setStatusMessage('Saved PNG.')
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : `The image could not be ${action === 'copy' ? 'copied' : 'saved'}.`)
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <div
      className="modal-overlay listening-stats-share-overlay"
      data-presence={presence.phase}
      aria-hidden={presence.phase === 'exiting'}
      onClick={onClose}
    >
      <div
        className="modal-content listening-stats-share-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="listening-stats-share-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header listening-stats-share-modal-header">
          <div>
            <p>{LISTENING_STATS_SHARE_WIDTH} × {LISTENING_STATS_SHARE_HEIGHT} PNG</p>
            <h2 id="listening-stats-share-title">Share Listening Stats</h2>
          </div>
          <button ref={closeButtonRef} className="modal-close" type="button" onClick={onClose} aria-label="Close share preview">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className="modal-body listening-stats-share-body">
          <div className="listening-stats-share-preview-shell">
            <canvas
              ref={canvasRef}
              className="listening-stats-share-canvas"
              width={LISTENING_STATS_SHARE_WIDTH}
              height={LISTENING_STATS_SHARE_HEIGHT}
              role="img"
              aria-label={`${model.title} share-card preview for ${model.rangeLabel}`}
            />
            {isPreparing && <div className="listening-stats-share-preview-state" role="status">Preparing artwork…</div>}
          </div>

          <aside className="listening-stats-share-controls" aria-label="Share-card options">
            <div>
              <span className="listening-stats-share-control-label">Card</span>
              <div className="listening-stats-share-lens-control" role="group" aria-label="Share-card type">
                {LENS_OPTIONS.map((option) => {
                  const unavailable = option.value === 'track'
                    ? displayedSnapshot.topTracks.length === 0
                    : option.value === 'album'
                      ? displayedSnapshot.topAlbums.length === 0
                      : false
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={lens === option.value ? 'active' : ''}
                      aria-pressed={lens === option.value}
                      disabled={unavailable || busyAction !== null}
                      onClick={() => setLens(option.value)}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <dl className="listening-stats-share-details">
              <div>
                <dt>Range</dt>
                <dd>{model.rangeLabel}</dd>
              </div>
              <div>
                <dt>Ranking</dt>
                <dd>{model.rankingLabel.replace('RANKED BY ', '')}</dd>
              </div>
            </dl>

            <p className="listening-stats-share-note">
              The preview is frozen from the stats currently on screen. No file paths or device information are included.
            </p>

            {(statusMessage || errorMessage) && (
              <p
                className={`listening-stats-share-message ${errorMessage ? 'is-error' : 'is-success'}`}
                role={errorMessage ? 'alert' : 'status'}
              >
                {errorMessage ?? statusMessage}
              </p>
            )}
          </aside>
        </div>

        <div className="modal-footer listening-stats-share-footer">
          <button
            className="settings-btn"
            type="button"
            disabled={isPreparing || busyAction !== null}
            onClick={() => void exportPng('copy')}
          >
            {busyAction === 'copy' ? 'Copying…' : 'Copy Image'}
          </button>
          <button
            className="settings-btn settings-btn-primary"
            type="button"
            disabled={isPreparing || busyAction !== null}
            onClick={() => void exportPng('save')}
          >
            {busyAction === 'save' ? 'Saving…' : 'Save PNG'}
          </button>
        </div>
      </div>
    </div>
  )
}
