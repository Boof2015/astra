import { useMemo, useState, type ReactNode } from 'react'
import type { ProviderSyncChoice, ProviderSyncDifference, ProviderSyncReview } from '../../../../types/providerSync'
import { usePresence, type PresencePhase } from '../../../hooks/usePresence'
import { useProviderSyncStore } from '../../../stores/providerSyncStore'
import SettingsSegmentedControl from '../SettingsSegmentedControl'
import {
  agreeingTracks, compareSummary, DEFAULT_COMPARE, isClash, KEEP_BOTH_DESCRIPTION, resolveChoices, rowKind, rowOptions, ruleChoice,
  SYNCED_VALUES, type ClashChoice, type CompareRule, type RoundChoice, type RowKind
} from './compareModel'
import { AlertIcon, ChevronRightIcon } from './ServerParts'
import { ServerWindow, Spinner } from './ServerWindow'
import { serverForKey, useServers } from './useServers'

/** Rows render a page at a time; a large first comparison can have thousands. */
const PAGE = 150
const GROUP_LABEL: Record<RowKind, string> = { favorite: 'Favorites', rating: 'Ratings', half: 'Half-star ratings' }
const GROUP_ORDER: RowKind[] = ['favorite', 'rating', 'half']
const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`

/**
 * Comparing values before favorites/ratings sync turns on, or reviewing changes
 * made on both sides since the last sync. Rule first: one choice settles every
 * difference; the track list is there to check, and to override single tracks.
 * Every choice resolves to the per-row values the backend already applies.
 */
export default function CompareWindow() {
  const review = useProviderSyncStore(state => state.review)
  const presence = usePresence(review)
  if (!presence.shouldRender || !presence.presentValue) return null
  return <CompareContent key={presence.presentValue.token} review={presence.presentValue} phase={presence.phase} />
}

function CompareContent({ review, phase }: { review: ProviderSyncReview; phase: PresencePhase }) {
  const working = useProviderSyncStore(state => state.working)
  const error = useProviderSyncStore(state => state.error)
  const { apply, closeReview, refreshReview } = useProviderSyncStore.getState()
  const provider = review.ref.provider
  const server = serverForKey(useServers(), `${provider}:${review.ref.sourceId}`)
  const serverName = server?.name ?? 'this server'
  // A Plex server's libraries are compared one at a time: say which, and how far along.
  const step = useProviderSyncStore(state => state.queueStep)
  const library = server && server.libraries.length > 1 ? server.libraries.find(item => item.id === review.ref.sourceId)?.name : undefined
  const where = library ? `${library}${step ? `, ${step.index} of ${step.total}` : ''}` : null

  const [rule, setRule] = useState<CompareRule>(DEFAULT_COMPARE.rule)
  const [clash, setClash] = useState<ClashChoice>(DEFAULT_COMPARE.clash)
  const [round, setRound] = useState<RoundChoice>(DEFAULT_COMPARE.round)
  const [overrides, setOverrides] = useState<Record<string, ProviderSyncChoice>>({})
  const [listOpen, setListOpen] = useState(false)
  const [shown, setShown] = useState(PAGE)

  const rows = review.differences
  const settings = { rule, clash, round }
  const choices = useMemo(() => resolveChoices(rows, provider, settings, overrides), [rows, provider, rule, clash, round, overrides])
  const summary = useMemo(() => compareSummary(rows, choices, provider), [rows, choices, provider])
  const grouped = useMemo(() => GROUP_ORDER.flatMap(kind => rows.filter(item => rowKind(item, provider) === kind)), [rows, provider])
  const clashes = useMemo(() => rows.filter(isClash).length, [rows])
  const halves = useMemo(() => rows.filter(item => rowKind(item, provider) === 'half').length, [rows, provider])
  const groupCounts = useMemo(() => {
    const counts: Record<RowKind, number> = { favorite: 0, rating: 0, half: 0 }
    for (const item of rows) counts[rowKind(item, provider)]++
    return counts
  }, [rows, provider])
  const picked = Object.keys(overrides).length
  const differingTracks = useMemo(() => new Set(rows.map(item => item.path)).size, [rows])

  // A pick that matches what the rule would do isn't a pick, so it doesn't linger as one.
  const pick = (item: ProviderSyncDifference, choice: ProviderSyncChoice) => setOverrides(current => {
    const next = { ...current }
    if (choice === ruleChoice(item, provider, settings)) delete next[item.key]
    else next[item.key] = choice
    return next
  })

  const ruleCard = (value: CompareRule, title: string, description: string, extra?: ReactNode) => (
    <div className={`servers-rule${rule === value ? ' is-on' : ''}`}>
      <button type="button" className="servers-rule-pick" aria-pressed={rule === value} disabled={working}
        data-autofocus={value === 'both' ? true : undefined} onClick={() => setRule(value)}>
        <span className="servers-radio" />
        <span className="servers-pick-text"><span>{title}</span><span className="servers-hint">{description}</span></span>
      </button>
      {extra && rule === value && <div className="servers-rule-extra">{extra}</div>}
    </div>
  )

  const clashExtra = clashes > 0 && provider !== 'jellyfin' ? (
    <>
      <span>{plural(clashes, 'track has', 'tracks have')} a different rating on each side. Keep</span>
      <SettingsSegmentedControl<ClashChoice> ariaLabel="Ratings that differ" className="servers-seg servers-seg-compare"
        disabled={working} value={clash} onChange={setClash}
        options={[{ value: 'local', label: 'Astra’s' }, { value: 'server', label: 'The server’s' }]} />
    </>
  ) : undefined

  let lastGroup: RowKind | null = null
  const list = grouped.slice(0, shown).flatMap(item => {
    const kind = rowKind(item, provider)
    const head = kind !== lastGroup ? (
      <div key={`head-${kind}`} className="servers-cmp-group">{GROUP_LABEL[kind]} <span>{groupCounts[kind].toLocaleString('en-US')}</span></div>
    ) : null
    lastGroup = kind
    const row = (
      <div key={item.key} className={`servers-cmp-item${overrides[item.key] ? ' is-picked' : ''}`}>
        <div className="servers-cmp-track">
          <span className="servers-cmp-title">{item.title}</span>
          <span className="servers-cmp-artist">{item.artist}</span>
        </div>
        <SettingsSegmentedControl<ProviderSyncChoice> ariaLabel={`${item.title}: value to keep`}
          className="servers-seg servers-seg-compare" disabled={working} value={choices[item.key]}
          options={rowOptions(item, provider)} onChange={choice => pick(item, choice)} />
      </div>
    )
    return head ? [head, row] : [row]
  })

  const title = review.enabling ? `Turn on sync with ${serverName}` : `Review ${plural(rows.length, 'change')}`
  return (
    <ServerWindow phase={phase} wide title={title} busy={working} onClose={closeReview}
      subtitle={review.enabling ? `${where ? `${where} · ` : ''}Sync ${SYNCED_VALUES[provider]}. Nothing changes until you confirm.` : where ?? undefined}
      footer={<>
        <span className="servers-cmp-summary">
          Changes <b>{plural(summary.serverTracks, 'track')}</b> on the server and <b>{summary.astraTracks.toLocaleString('en-US')}</b> in Astra
        </span>
        <button type="button" className="servers-btn" disabled={working} onClick={closeReview}>Cancel</button>
        <button type="button" className="servers-btn is-accent" disabled={working || !!error} onClick={() => void apply(choices)}>
          {working ? <><Spinner />Applying…</> : review.enabling ? 'Turn on sync' : 'Apply'}
        </button>
      </>}>
      {review.enabling ? (
        <p className="servers-window-text">
          <span className="servers-mono">{agreeingTracks(review.matchedTracks, rows).toLocaleString('en-US')}</span> tracks already match
          {' · '}<span className="servers-mono">{differingTracks.toLocaleString('en-US')}</span> differ
          {review.missingTracks > 0 && <>{' · '}<span className="servers-mono">{review.missingTracks.toLocaleString('en-US')}</span> aren’t on the server and are left alone</>}.
        </p>
      ) : (
        <p className="servers-window-text">These tracks changed in Astra and on {serverName} since the last sync.</p>
      )}
      {error && (
        <div className="servers-window-error" role="alert">
          <AlertIcon />
          <div>
            {error} Some changes may already have been made. Refresh to compare the current values.
            <div className="servers-error-actions">
              <button type="button" className="servers-btn is-small" disabled={working} onClick={() => void refreshReview()}>
                Refresh comparison
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="servers-field">
        <span>How should the differences be settled?</span>
        <div className="servers-rules">
          {ruleCard('both', 'Keep both', KEEP_BOTH_DESCRIPTION[provider], clashExtra)}
          {ruleCard('astra', 'Use Astra’s values', 'The server is changed to match Astra.')}
          {ruleCard('server', 'Use the server’s values', 'Astra is changed to match the server.')}
        </div>
      </div>
      {halves > 0 && rule !== 'server' && (
        <div className="servers-half-row">
          <div className="servers-row-text">
            <span className="servers-label">{plural(halves, 'half-star rating')} can’t be stored on this server</span>
            <span className="servers-sub">Subsonic only stores whole stars.</span>
          </div>
          <SettingsSegmentedControl<RoundChoice> ariaLabel="Half-star ratings" className="servers-seg servers-seg-compare"
            disabled={working} value={round} onChange={setRound}
            options={[{ value: 'up', label: 'Round up' }, { value: 'down', label: 'Round down' }]} />
        </div>
      )}
      <button type="button" className={`servers-disclose${listOpen ? ' is-open' : ''}`} aria-expanded={listOpen}
        onClick={() => setListOpen(open => !open)}>
        <span className="servers-disclose-chev"><ChevronRightIcon /></span>
        {listOpen ? 'Hide tracks' : `See all ${plural(rows.length, 'change')}`}
        {picked > 0 && <span className="servers-hint"> · {picked.toLocaleString('en-US')} picked by hand</span>}
      </button>
      {listOpen && (
        <div className="servers-cmp-list">
          {list}
          {shown < grouped.length && (
            <button type="button" className="servers-btn is-small servers-cmp-more" onClick={() => setShown(count => count + PAGE)}>
              Show {Math.min(PAGE, grouped.length - shown).toLocaleString('en-US')} more
            </button>
          )}
        </div>
      )}
    </ServerWindow>
  )
}
