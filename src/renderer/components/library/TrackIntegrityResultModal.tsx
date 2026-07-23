import LocalizedText from '../i18n/LocalizedText'
import { translate } from '../../i18n'
import { useMemo } from 'react'
import { useLibraryIntegrityStore } from '../../stores/libraryIntegrityStore'
import { IntegrityFindingList } from './LibraryIntegrityPanel'
import { usePresence } from '../../hooks/usePresence'

function formatTrackPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts.slice(Math.max(0, parts.length - 3)).join('/')
}

export default function TrackIntegrityResultModal() {
  const liveResult = useLibraryIntegrityStore((state) => state.singleTrackResult)
  const liveBusyPath = useLibraryIntegrityStore((state) => state.singleTrackBusyPath)
  const liveBusyPaths = useLibraryIntegrityStore((state) => state.singleTrackBusyPaths)
  const liveError = useLibraryIntegrityStore((state) => state.singleTrackError)
  const close = useLibraryIntegrityStore((state) => state.closeSingleTrackResult)
  const isVisible = Boolean(liveResult || liveBusyPath || liveBusyPaths.length > 0 || liveError)
  const presence = usePresence(isVisible ? {
    result: liveResult,
    busyPath: liveBusyPath,
    busyPaths: liveBusyPaths,
    error: liveError
  } : null)
  const result = presence.presentValue?.result ?? null
  const busyPath = presence.presentValue?.busyPath ?? null
  const busyPaths = presence.presentValue?.busyPaths ?? []
  const error = presence.presentValue?.error ?? ''

  const title = useMemo(() => {
    if (busyPaths.length > 1) return 'Checking Selection'
    if (busyPath) return 'Checking Track'
    if (result?.summary.scope.type === 'track') return formatTrackPath(result.summary.scope.trackPath)
    if (result?.summary.scope.type === 'tracks') return 'Selection Integrity'
    return 'Track Integrity'
  }, [busyPath, busyPaths.length, result])

  if (!presence.shouldRender) return null

  const findings = result?.findings ?? []
  const isBusy = busyPaths.length > 0 || Boolean(busyPath)
  const resultTrackCount = result?.summary.scope.type === 'tracks'
    ? result.summary.scope.trackPaths.length
    : result?.summary.scope.type === 'track'
      ? 1
      : null

  return (
    <div
      className="modal-overlay track-integrity-overlay"
      data-presence={presence.phase}
      aria-hidden={presence.phase === 'exiting'}
      onClick={isBusy ? undefined : close}
    >
      <div className="modal-content track-integrity-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="library-integrity-kicker"><LocalizedText ns="library" i18nKey="auto.trackintegrityresultmodal.track_integrity" /></div>
            <h2>{title}</h2>
          </div>
          <button className="modal-close" onClick={close} disabled={isBusy} aria-label={translate('library:auto.trackintegrityresultmodal.close')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
        <div className="modal-body track-integrity-body">
          {isBusy ? (
            <div className="track-integrity-loading">
              <span className="loading-spinner-small" />
              <span>
                {busyPaths.length > 1
                  ? translate('library:auto.trackintegrityresultmodal.length_selected_tracks', { length: busyPaths.length })
                  : busyPath
                    ? formatTrackPath(busyPath)
                    : translate('library:auto.trackintegrityresultmodal.preparing_integrity_check')}
              </span>
            </div>
          ) : error ? (
            <div className="library-integrity-error" role="alert">{error}</div>
          ) : (
            <>
              {result && (
                <div className="track-integrity-summary">
                  <span>{result.summary.mode === 'deep' ? translate('library:auto.trackintegrityresultmodal.deep') : translate('library:auto.trackintegrityresultmodal.quick')}  <LocalizedText ns="library" i18nKey="auto.trackintegrityresultmodal.scan" /></span>
                  {resultTrackCount !== null && (
                    <span>{resultTrackCount} {resultTrackCount === 1 ? translate('library:auto.trackintegrityresultmodal.track') : translate('library:auto.trackintegrityresultmodal.tracks')}</span>
                  )}
                  <span>{result.summary.errors}  <LocalizedText ns="library" i18nKey="auto.trackintegrityresultmodal.errors" /></span>
                  <span>{result.summary.warnings}  <LocalizedText ns="library" i18nKey="auto.trackintegrityresultmodal.warnings" /></span>
                  <span>{result.summary.info}  <LocalizedText ns="library" i18nKey="auto.trackintegrityresultmodal.info" /></span>
                </div>
              )}
              <IntegrityFindingList
                findings={findings}
                emptyLabel={result?.summary.scope.type === 'tracks'
                  ? 'No integrity findings for the selected tracks.'
                  : 'No integrity findings for this track.'}
              />
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="settings-btn settings-btn-primary" onClick={close} disabled={isBusy}>

            <LocalizedText ns="library" i18nKey="auto.trackintegrityresultmodal.done" />
          </button>
        </div>
      </div>
    </div>
  )
}
