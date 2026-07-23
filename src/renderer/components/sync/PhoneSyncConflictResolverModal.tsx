import LocalizedText from '../i18n/LocalizedText'
import { formatLocaleDate, translate } from '../../i18n'
import { useEffect, useMemo, useState } from 'react'
import { usePresence } from '../../hooks/usePresence'
import { usePhoneRemoteSettingsStore } from '../../stores/phoneRemoteSettingsStore'
import {
  buildSyncConflictResolutionPreview,
  buildSyncPlaylistEntryDiff,
  type SyncPlaylistEntryDiff
} from '../../../shared/sync/conflictPreview'
import type {
  PhoneSyncConflictResolution,
  PhoneSyncPendingResolution,
  PhoneSyncReportedConflict,
  SyncPlaylistSnapshot
} from '../../../types/phoneSync'

function fallbackSnapshot(conflict: PhoneSyncReportedConflict, side: 'desktop' | 'phone'): SyncPlaylistSnapshot {
  const isDesktop = side === 'desktop'
  return {
    name: isDesktop
      ? conflict.desktopName || conflict.name || 'Desktop playlist'
      : conflict.phoneName || conflict.name || 'Phone playlist',
    kind: conflict.playlistKind,
    dynamicRules: null,
    updatedAt: isDesktop ? conflict.desktopUpdatedAt : conflict.phoneUpdatedAt,
    trackCount: isDesktop ? conflict.desktopTrackCount : conflict.phoneTrackCount,
    entries: null
  }
}

function formatDate(value: number): string {
  return value > 0
    ? formatLocaleDate(value, { dateStyle: 'medium', timeStyle: 'short' })
    : translate('common:states.unknown')
}

function sideMeta(snapshot: SyncPlaylistSnapshot): string {
  const kind = snapshot.kind === 'dynamic'
    ? 'Dynamic playlist'
    : `${snapshot.trackCount} song${snapshot.trackCount === 1 ? '' : 's'}`
  return `${kind} · edited ${formatDate(snapshot.updatedAt)}`
}

function describeConflict(conflict: PhoneSyncReportedConflict): string {
  return conflict.kind === 'first-pairing'
    ? 'Same-name playlists differ before their first sync.'
    : 'Both devices edited this playlist since the last sync.'
}

const RESOLUTION_LABELS: Record<PhoneSyncConflictResolution, string> = {
  desktop: 'Use desktop',
  phone: 'Use phone',
  both: 'Keep both',
  merge: 'Combine songs'
}

function confirmLabel(resolution: PhoneSyncConflictResolution | null): string {
  if (!resolution) return 'Choose an option'
  switch (resolution) {
    case 'desktop':
      return 'Confirm use desktop'
    case 'phone':
      return 'Confirm use phone'
    case 'both':
      return 'Confirm keep both'
    case 'merge':
      return 'Confirm combine songs'
  }
}

function resolutionOptions(canMerge: boolean): PhoneSyncConflictResolution[] {
  return canMerge ? ['desktop', 'phone', 'both', 'merge'] : ['desktop', 'phone', 'both']
}

function columnStateClass(side: 'desktop' | 'phone', resolution: PhoneSyncConflictResolution | null): string {
  if (!resolution) return ''
  if (resolution === 'both' || resolution === 'merge' || resolution === side) return 'is-preview-active'
  return 'is-preview-dimmed'
}

function rowPreviewLabel(
  row: SyncPlaylistEntryDiff,
  side: 'desktop' | 'phone',
  resolution: PhoneSyncConflictResolution | null
): string | null {
  if (!resolution) return null
  if (resolution === 'both') return 'Separate'
  if (resolution === 'merge') return row.status === 'moved' ? 'Order chosen' : 'Added'
  if (resolution === side) return row.status === 'moved' ? 'Order kept' : 'Kept'
  return row.status === 'moved' ? 'Order changes' : 'Removed'
}

function moveStatusLabel(row: SyncPlaylistEntryDiff, side: 'desktop' | 'phone'): string {
  if (row.status === 'moved') {
    const from = side === 'desktop' ? row.desktopIndex : row.phoneIndex
    const to = side === 'desktop' ? row.phoneIndex : row.desktopIndex
    return from !== null && to !== null ? `${from + 1} to ${to + 1}` : 'Different order'
  }
  return ''
}

function TrackSideRow({
  row,
  side,
  resolution
}: {
  row: SyncPlaylistEntryDiff
  side: 'desktop' | 'phone'
  resolution: PhoneSyncConflictResolution | null
}) {
  const subtitle = [row.artist, row.album].filter((part) => part.trim().length > 0).join(' · ')
  const previewLabel = rowPreviewLabel(row, side, resolution)
  const statusLabel = previewLabel ?? moveStatusLabel(row, side)
  const fateClass = previewLabel
    ? `will-${previewLabel.toLowerCase().replace(/\s+/g, '-')}`
    : ''
  return (
    <div className={`phone-sync-side-track is-${row.status} ${fateClass}`.trim()}>
      <div className="phone-sync-diff-track">
        <span className="phone-sync-diff-title">{row.title || 'Untitled track'}</span>
        {subtitle && <span className="phone-sync-diff-subtitle">{subtitle}</span>}
      </div>
      {statusLabel && <span className="phone-sync-side-track-status">{statusLabel}</span>}
    </div>
  )
}

function TrackSideList({
  side,
  sideOnlyRows,
  movedRows,
  resolution
}: {
  side: 'desktop' | 'phone'
  sideOnlyRows: SyncPlaylistEntryDiff[]
  movedRows: SyncPlaylistEntryDiff[]
  resolution: PhoneSyncConflictResolution | null
}) {
  const sideName = side === 'desktop' ? 'desktop' : 'phone'
  if (sideOnlyRows.length === 0 && movedRows.length === 0) {
    return <p className="phone-sync-empty-note"><LocalizedText ns="integrations" i18nKey="auto.phonesyncconflictresolvermodal.no_songs_only_on" /> {sideName}.</p>
  }
  return (
    <div className="phone-sync-side-track-list">
      {sideOnlyRows.length > 0 && (
        <>
          <div className="phone-sync-track-section-label"><LocalizedText ns="integrations" i18nKey="auto.phonesyncconflictresolvermodal.only_on" /> {sideName}</div>
          {sideOnlyRows.map((row) => (
            <TrackSideRow key={row.key} row={row} side={side} resolution={resolution} />
          ))}
        </>
      )}
      {movedRows.length > 0 && (
        <>
          <div className="phone-sync-track-section-label"><LocalizedText ns="integrations" i18nKey="auto.phonesyncconflictresolvermodal.different_order" /></div>
          {movedRows.map((row) => (
            <TrackSideRow key={row.key} row={row} side={side} resolution={resolution} />
          ))}
        </>
      )}
    </div>
  )
}

export default function PhoneSyncConflictResolverModal() {
  const isOpen = usePhoneRemoteSettingsStore((s) => s.syncConflictResolverOpen)
  const status = usePhoneRemoteSettingsStore((s) => s.status)
  const close = usePhoneRemoteSettingsStore((s) => s.closeSyncConflictResolver)
  const resolveSyncConflict = usePhoneRemoteSettingsStore((s) => s.resolveSyncConflict)
  const conflicts = status?.sync?.conflicts ?? []
  const pendingResolutions = status?.sync?.pendingResolutions ?? []
  const presence = usePresence(isOpen && conflicts.length > 0 ? { conflicts, pendingResolutions } : null)
  const [selectedUid, setSelectedUid] = useState<string | null>(null)
  const [selectedPreview, setSelectedPreview] = useState<{
    syncUid: string
    resolution: PhoneSyncConflictResolution
  } | null>(null)

  useEffect(() => {
    if (!isOpen || conflicts.length === 0) return
    if (selectedUid && conflicts.some((conflict) => conflict.syncUid === selectedUid)) return
    setSelectedUid(conflicts[0].syncUid)
  }, [conflicts, isOpen, selectedUid])

  const activeConflict = conflicts.find((conflict) => conflict.syncUid === selectedUid) ?? conflicts[0] ?? null

  const pendingByUid = useMemo(() => {
    return new Map(pendingResolutions.map((entry: PhoneSyncPendingResolution) => [entry.syncUid, entry.resolution]))
  }, [pendingResolutions])

  if (!presence.shouldRender || !presence.presentValue || !activeConflict) return null

  const displayedConflicts = presence.presentValue.conflicts
  const desktop = activeConflict.desktopSnapshot ?? fallbackSnapshot(activeConflict, 'desktop')
  const phone = activeConflict.phoneSnapshot ?? fallbackSnapshot(activeConflict, 'phone')
  const canMerge = desktop.kind === 'normal' && phone.kind === 'normal'
  const pendingResolution = pendingByUid.get(activeConflict.syncUid) ?? null
  const hasTrackDetails = desktop.entries !== null && phone.entries !== null
  const diff = hasTrackDetails ? buildSyncPlaylistEntryDiff(desktop.entries, phone.entries) : null
  const desktopOnlyRows = diff?.rows.filter((row) => row.status === 'desktop-only') ?? []
  const phoneOnlyRows = diff?.rows.filter((row) => row.status === 'phone-only') ?? []
  const movedRows = diff?.rows.filter((row) => row.status === 'moved') ?? []
  const actions = resolutionOptions(canMerge)
  const selectedResolution = selectedPreview?.syncUid === activeConflict.syncUid && actions.includes(selectedPreview.resolution)
    ? selectedPreview.resolution
    : null
  const selectedPreviewCopy = selectedResolution
    ? buildSyncConflictResolutionPreview(selectedResolution, desktop, phone)
    : null

  const confirm = () => {
    if (!selectedResolution || pendingResolution) return
    void resolveSyncConflict(activeConflict.syncUid, selectedResolution)
  }

  return (
    <div className="modal-overlay" data-presence={presence.phase} aria-hidden={presence.phase === 'exiting'} onClick={close}>
      <div className="modal-content phone-sync-conflict-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2><LocalizedText ns="integrations" i18nKey="auto.phonesyncconflictresolvermodal.resolve_library_sync_conflicts" /></h2>
          <button className="modal-close" onClick={close} aria-label={translate('integrations:auto.phonesyncconflictresolvermodal.close')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
        <div className="modal-body phone-sync-conflict-body">
          <aside className="phone-sync-conflict-list" aria-label={translate('integrations:auto.phonesyncconflictresolvermodal.sync_conflicts')}>
            {displayedConflicts.map((conflict) => {
              const pending = pendingByUid.get(conflict.syncUid)
              return (
                <button
                  key={conflict.syncUid}
                  type="button"
                  className={`phone-sync-conflict-list-item ${conflict.syncUid === activeConflict.syncUid ? 'is-active' : ''}`.trim()}
                  onClick={() => setSelectedUid(conflict.syncUid)}
                >
                  <span className="phone-sync-conflict-list-name">{conflict.name || conflict.desktopName || conflict.phoneName}</span>
                  <span className="phone-sync-conflict-list-detail">
                    {pending ? translate('integrations:auto.phonesyncconflictresolvermodal.waiting_for_phone_pending', { pending: pending }) : describeConflict(conflict)}
                  </span>
                </button>
              )
            })}
          </aside>

          <section className="phone-sync-conflict-detail">
            <div className="phone-sync-conflict-title-row">
              <div>
                <h3>{activeConflict.name || activeConflict.desktopName || activeConflict.phoneName}</h3>
                <p><LocalizedText ns="integrations" i18nKey="auto.phonesyncconflictresolvermodal.choose_an_outcome_preview_it_below_then_confirm" /></p>
              </div>
              {pendingResolution && (
                <span className="phone-sync-conflict-pending"><LocalizedText ns="integrations" i18nKey="auto.phonesyncconflictresolvermodal.waiting_for_phone" /> {pendingResolution}</span>
              )}
            </div>

            <div className="phone-sync-action-grid" aria-label={translate('integrations:auto.phonesyncconflictresolvermodal.conflict_resolution_actions')}>
              {actions.map((resolution) => {
                const preview = buildSyncConflictResolutionPreview(resolution, desktop, phone)
                return (
                  <button
                    key={resolution}
                    type="button"
                    className={`phone-sync-action-button is-${resolution} ${selectedResolution === resolution ? 'is-selected' : ''}`.trim()}
                    onClick={() => setSelectedPreview({ syncUid: activeConflict.syncUid, resolution })}
                    disabled={Boolean(pendingResolution)}
                  >
                    <strong>{RESOLUTION_LABELS[resolution]}</strong>
                    <span>
                      {preview.resultTrackCount === null
                        ? preview.detail
                        : translate('integrations:auto.phonesyncconflictresolvermodal.resulttrackcount_song_value2_detail', { resulttrackcount: preview.resultTrackCount, value2: preview.resultTrackCount === 1 ? '' : 's', detail: preview.detail })}
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="phone-sync-outcome-preview" data-resolution={selectedResolution ?? 'none'}>
              <div>
                <span className="phone-sync-resolution-preview-label"><LocalizedText ns="integrations" i18nKey="auto.phonesyncconflictresolvermodal.preview" /></span>
                <strong>{selectedPreviewCopy ? selectedPreviewCopy.title : translate('integrations:auto.phonesyncconflictresolvermodal.no_option_selected')}</strong>
                <span>
                  {selectedPreviewCopy
                    ? selectedPreviewCopy.detail
                    : translate('integrations:auto.phonesyncconflictresolvermodal.pick_an_option_above_to_see_which_playlist_stays_changes')}
                </span>
              </div>
              {selectedPreviewCopy && selectedPreviewCopy.resultTrackCount !== null && (
                <div className="phone-sync-after-pill">

                  <LocalizedText ns="integrations" i18nKey="auto.phonesyncconflictresolvermodal.after_sync" /> {selectedPreviewCopy.resultName} · {selectedPreviewCopy.resultTrackCount}  <LocalizedText ns="integrations" i18nKey="auto.phonesyncconflictresolvermodal.song" />{selectedPreviewCopy.resultTrackCount === 1 ? '' : translate('integrations:auto.phonesyncconflictresolvermodal.s')}
                </div>
              )}
            </div>

            <div className="phone-sync-compare-grid">
              <div className={`phone-sync-compare-column ${columnStateClass('desktop', selectedResolution)}`.trim()}>
                <div className="phone-sync-side-label"><LocalizedText ns="integrations" i18nKey="auto.phonesyncconflictresolvermodal.desktop" /></div>
                <div className="phone-sync-side-name">{desktop.name}</div>
                <div className="phone-sync-side-meta">{sideMeta(desktop)}</div>
                {desktop.kind === 'dynamic' ? (
                  <pre className="phone-sync-rules-preview">{desktop.dynamicRules ?? 'No rules'}</pre>
                ) : hasTrackDetails ? (
                  <TrackSideList
                    side="desktop"
                    sideOnlyRows={desktopOnlyRows}
                    movedRows={movedRows}
                    resolution={selectedResolution}
                  />
                ) : (
                  <p className="phone-sync-empty-note"><LocalizedText ns="integrations" i18nKey="auto.phonesyncconflictresolvermodal.track_level_details_are_not_available_from_this_phone_ye" /></p>
                )}
              </div>

              <div className={`phone-sync-compare-column ${columnStateClass('phone', selectedResolution)}`.trim()}>
                <div className="phone-sync-side-label"><LocalizedText ns="integrations" i18nKey="auto.phonesyncconflictresolvermodal.phone" /></div>
                <div className="phone-sync-side-name">{phone.name}</div>
                <div className="phone-sync-side-meta">{sideMeta(phone)}</div>
                {phone.kind === 'dynamic' ? (
                  <pre className="phone-sync-rules-preview">{phone.dynamicRules ?? 'No rules'}</pre>
                ) : hasTrackDetails ? (
                  <TrackSideList
                    side="phone"
                    sideOnlyRows={phoneOnlyRows}
                    movedRows={movedRows}
                    resolution={selectedResolution}
                  />
                ) : (
                  <p className="phone-sync-empty-note"><LocalizedText ns="integrations" i18nKey="auto.phonesyncconflictresolvermodal.summary_count" /> {phone.trackCount}  <LocalizedText ns="integrations" i18nKey="auto.phonesyncconflictresolvermodal.song" />{phone.trackCount === 1 ? '' : translate('integrations:auto.phonesyncconflictresolvermodal.s')}.</p>
                )}
              </div>
            </div>

            {diff && (
              <div className="phone-sync-compare-summary">
                {diff.desktopOnlyCount}  <LocalizedText ns="integrations" i18nKey="auto.phonesyncconflictresolvermodal.only_on_desktop" /> {diff.phoneOnlyCount}  <LocalizedText ns="integrations" i18nKey="auto.phonesyncconflictresolvermodal.only_on_phone" /> {diff.movedCount}  <LocalizedText ns="integrations" i18nKey="auto.phonesyncconflictresolvermodal.in_a_different_order" />
              </div>
            )}
          </section>
        </div>
        <div className="modal-footer">
          <button className="settings-btn" onClick={close}><LocalizedText ns="integrations" i18nKey="auto.phonesyncconflictresolvermodal.close" /></button>
          <button
            className="settings-btn settings-btn-primary"
            onClick={confirm}
            disabled={!selectedResolution || Boolean(pendingResolution)}
          >
            {confirmLabel(selectedResolution)}
          </button>
        </div>
      </div>
    </div>
  )
}
