import { useMemo } from 'react'
import { useLibraryIntegrityStore } from '../../stores/libraryIntegrityStore'
import { IntegrityFindingList } from './LibraryIntegrityPanel'

function formatTrackPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts.slice(Math.max(0, parts.length - 3)).join('/')
}

export default function TrackIntegrityResultModal() {
  const result = useLibraryIntegrityStore((state) => state.singleTrackResult)
  const busyPath = useLibraryIntegrityStore((state) => state.singleTrackBusyPath)
  const error = useLibraryIntegrityStore((state) => state.singleTrackError)
  const close = useLibraryIntegrityStore((state) => state.closeSingleTrackResult)

  const title = useMemo(() => {
    if (busyPath) return 'Checking Track'
    if (result?.summary.scope.type === 'track') return formatTrackPath(result.summary.scope.trackPath)
    return 'Track Integrity'
  }, [busyPath, result])

  if (!result && !busyPath && !error) return null

  const findings = result?.findings ?? []

  return (
    <div className="modal-overlay track-integrity-overlay" onClick={busyPath ? undefined : close}>
      <div className="modal-content track-integrity-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="library-integrity-kicker">Track Integrity</div>
            <h2>{title}</h2>
          </div>
          <button className="modal-close" onClick={close} disabled={Boolean(busyPath)} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
        <div className="modal-body track-integrity-body">
          {busyPath ? (
            <div className="track-integrity-loading">
              <span className="loading-spinner-small" />
              <span>{formatTrackPath(busyPath)}</span>
            </div>
          ) : error ? (
            <div className="library-integrity-error" role="alert">{error}</div>
          ) : (
            <>
              {result && (
                <div className="track-integrity-summary">
                  <span>{result.summary.mode === 'deep' ? 'Deep' : 'Quick'} scan</span>
                  <span>{result.summary.errors} errors</span>
                  <span>{result.summary.warnings} warnings</span>
                  <span>{result.summary.info} info</span>
                </div>
              )}
              <IntegrityFindingList
                findings={findings}
                emptyLabel="No integrity findings for this track."
              />
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="settings-btn settings-btn-primary" onClick={close} disabled={Boolean(busyPath)}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
