import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useProviderSyncStore } from '../../stores/providerSyncStore'
import { useSubsonicSettingsStore } from '../../stores/subsonicSettingsStore'
import { useJellyfinSettingsStore } from '../../stores/jellyfinSettingsStore'
import { resolveProviderChoice, validProviderValue } from '../../../shared/sync/providerState'
import type { ProviderSyncChoice, ProviderSyncDifference, ProviderSyncValue } from '../../../types/providerSync'

const format = (value: ProviderSyncValue) => typeof value === 'boolean' ? (value ? 'Favorite' : 'Not favorite') : value === null ? 'Unrated' : `${value} ★`
const labels: Record<ProviderSyncChoice, string> = { local: 'Keep Astra', server: 'Keep server', up: 'Round up', down: 'Round down', clear: 'Clear rating' }
function validChoice(row: ProviderSyncDifference, choice: ProviderSyncChoice | undefined): boolean {
  try { resolveProviderChoice(row, choice!); return true } catch { return false }
}

export default function ProviderSyncReviewModal() {
  const { review, working, error, apply, closeReview, openReview } = useProviderSyncStore()
  const subsonicSources = useSubsonicSettingsStore(s => s.sources)
  const jellyfinSources = useJellyfinSettingsStore(s => s.sources)
  const [choices, setChoices] = useState<Record<string, ProviderSyncChoice>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)
  const [preview, setPreview] = useState(false)
  const modal = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setChoices({}); setSelected(new Set()); setPage(0); setPreview(false)
    if (!review) return
    const previous = document.activeElement as HTMLElement | null
    requestAnimationFrame(() => modal.current?.focus())
    return () => previous?.focus()
  }, [review?.token])
  if (!review) return null
  const sourceName = (review.ref.provider === 'subsonic' ? subsonicSources : jellyfinSources).find(s => s.id === review.ref.sourceId)?.name
    ?? `${review.ref.provider === 'subsonic' ? 'Subsonic' : 'Jellyfin'} server ${review.ref.sourceId}`
  const rows = review.differences
  const unresolved = rows.filter(row => !validChoice(row, choices[row.key])).length
  const visible = rows.slice(page * 100, (page + 1) * 100)
  const bulk = (choice: ProviderSyncChoice) => setChoices(current => {
    const next = { ...current }
    for (const row of rows) {
      if (selected.size && !selected.has(row.key)) continue
      if (validChoice(row, choice)) next[row.key] = choice
    }
    return next
  })
  return createPortal(<div className="modal-overlay" onClick={closeReview}>
    <div className="modal-content provider-sync-modal" role="dialog" aria-modal="true" aria-labelledby="provider-sync-title"
      ref={modal} tabIndex={-1} onClick={event => event.stopPropagation()} onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); closeReview() }
        if (event.key === 'Tab') {
          const focusable = modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)')
          if (!focusable?.length) return
          const first = focusable[0], last = focusable[focusable.length - 1]
          if (event.shiftKey && (document.activeElement === first || document.activeElement === modal.current)) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
      }}>
      <div className="modal-header"><h2 id="provider-sync-title">{preview ? 'Preview sync changes' : 'Compare server values'}</h2>
        <button className="modal-close" onClick={closeReview} disabled={working} aria-label="Close">×</button></div>
      <div className="modal-body">
        <p><strong>{sourceName}</strong> · {review.matchedTracks} matching tracks · {rows.length} differences{review.missingTracks ? ` · ${review.missingTracks} unavailable tracks left unchanged` : ''}</p>
        <p className="settings-note">{review.enabling ? 'Sync stays off until you confirm. ' : ''}
          {preview ? 'These are the values both Astra and this server will keep.' : `Choose values for each difference.${review.ref.provider === 'subsonic' ? ' Existing half-star ratings need a whole-star choice or clearing.' : ''}`}</p>
        {error && <div role="alert" className="provider-sync-error">{error} Some confirmed changes may already have applied. Refresh to compare the current values. <button className="settings-btn" disabled={working}
          onClick={() => void openReview(review.ref)}>Refresh comparison</button></div>}
        {!preview && rows.length > 0 && <div className="provider-sync-bulk">
          <span>{selected.size ? `${selected.size} selected` : `All ${rows.length} differences`}</span>
          {(Object.keys(labels) as ProviderSyncChoice[]).filter(choice => review.ref.provider === 'subsonic' || choice === 'local' || choice === 'server').map(choice =>
            <button key={choice} className="settings-btn" disabled={working} onClick={() => bulk(choice)}>{labels[choice]}</button>)}
          {selected.size > 0 && <button className="settings-btn" onClick={() => setSelected(new Set())}>Clear selection</button>}
        </div>}
        {rows.length > 0 ? <div className="provider-sync-table-wrap"><table className="provider-sync-table">
          <thead><tr>{!preview && <th>Select</th>}<th>Track</th><th>Field</th><th>Astra</th><th>Server</th><th>{preview ? 'Result' : 'Choice'}</th></tr></thead>
          <tbody>{visible.map(row => <tr key={row.key}>
            {!preview && <td className="provider-sync-select"><input type="checkbox" aria-label={`Select ${row.field} for ${row.title}`} checked={selected.has(row.key)}
              onChange={() => setSelected(current => { const next = new Set(current); if (next.has(row.key)) next.delete(row.key); else next.add(row.key); return next })} /></td>}
            <td className="provider-sync-track"><strong>{row.title}</strong><small>{row.artist}</small></td><td>{row.field === 'favorite' ? 'Favorite' : 'Rating'}</td>
            <td>{format(row.local)}</td><td>{format(row.server)}</td><td>{preview
              ? format(resolveProviderChoice(row, choices[row.key]))
              : <select aria-label={`Value to keep for ${row.title} ${row.field}`} value={choices[row.key] ?? ''} disabled={working}
                onChange={event => setChoices(current => ({ ...current, [row.key]: event.target.value as ProviderSyncChoice }))}>
                <option value="" disabled>Choose…</option>
                <option value="local" disabled={!validProviderValue(row.field, row.local)}>Keep Astra</option><option value="server">Keep server</option>
                {row.field === 'rating' && <><option value="up" disabled={typeof row.local !== 'number'}>Round up</option>
                  <option value="down" disabled={typeof row.local !== 'number'}>Round down</option><option value="clear">Clear rating</option></>}
              </select>}</td>
          </tr>)}</tbody></table></div> : <p>All matching values already agree.</p>}
        {rows.length > 100 && <div className="provider-sync-actions">
          <button className="settings-btn" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
          <span>Page {page + 1} of {Math.ceil(rows.length / 100)}</span>
          <button className="settings-btn" disabled={(page + 1) * 100 >= rows.length} onClick={() => setPage(page + 1)}>Next</button>
        </div>}
      </div>
      <div className="provider-sync-footer">
        <span>{unresolved ? `${unresolved} choices remaining` : `${rows.length} changes ready`}</span>
        <button className="settings-btn" disabled={working} onClick={closeReview}>Cancel</button>
        {preview ? <><button className="settings-btn" disabled={working} onClick={() => setPreview(false)}>Back</button>
          <button className="settings-btn settings-btn-primary" disabled={working || !!error} onClick={() => void apply(choices)}>
            {working ? 'Applying…' : review.enabling ? 'Confirm and enable sync' : 'Confirm changes'}</button></>
          : <button className="settings-btn settings-btn-primary" disabled={working || unresolved > 0 || !!error} onClick={() => setPreview(true)}>Preview changes</button>}
      </div>
    </div>
  </div>, document.body)
}
