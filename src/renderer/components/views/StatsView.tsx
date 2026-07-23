import LocalizedText from '../i18n/LocalizedText'
import { formatLocaleDate, formatLocaleNumber, translate, translateSourceText } from '../../i18n'
import { useEffect, useMemo, useState } from 'react'
import type {
  ListeningStatsActivityBucket,
  ListeningStatsRange,
  ListeningStatsRankedAlbum,
  ListeningStatsRankedArtist,
  ListeningStatsRankedTrack
} from '../../../types/listeningStats'
import { useLibraryStore } from '../../stores/libraryStore'
import { useListeningStatsStore } from '../../stores/listeningStatsStore'
import { usePlayerStore } from '../../stores/playerStore'
import { useUIStore } from '../../stores/uiStore'
import { formatExactDuration } from '../../utils/collectionDuration'
import AlbumArtwork from '../library/AlbumArtwork'
import StatsShareModal from '../stats/StatsShareModal'

const RANGE_OPTIONS: Array<{ value: ListeningStatsRange; label: string }> = [
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: '1y', label: '1Y' },
  { value: 'all', label: 'All' }
]

function formatCount(value: number): string {
  const rounded = Math.max(0, Math.round(value))
  return translate('common:counts.play', { count: rounded, formattedCount: formatLocaleNumber(rounded) })
}

function formatBaseline(timestamp: number): string {
  return formatLocaleDate(timestamp, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function ActivityChart({ buckets }: { buckets: ListeningStatsActivityBucket[] }) {
  const maxSeconds = Math.max(0, ...buckets.map((bucket) => bucket.listenedSeconds))

  return (
    <div className="listening-stats-chart" role="group" aria-label={translate('common:auto.statsview.listening_time_activity_chart')}>
      {buckets.map((bucket, index) => {
        const exactTime = formatExactDuration(bucket.listenedSeconds)
        const plays = formatCount(bucket.qualifiedPlays)
        const height = maxSeconds > 0 && bucket.listenedSeconds > 0
          ? Math.max(2, (bucket.listenedSeconds / maxSeconds) * 100)
          : 0
        const animationDelay = buckets.length > 1
          ? Math.round((index / (buckets.length - 1)) * 220)
          : 0
        const detail = `${bucket.label}: ${exactTime} listening time, ${plays}`
        return (
          <div className="listening-stats-bar-column" key={bucket.startAt}>
            <button className="listening-stats-bar-target" type="button" aria-label={detail} title={detail}>
              <span className="listening-stats-bar-detail" aria-hidden="true">{exactTime}</span>
              <span
                className="listening-stats-bar"
                style={{ height: `${height}%`, animationDelay: `${animationDelay}ms` }}
                aria-hidden="true"
              />
            </button>
            <span className="listening-stats-bar-label" aria-hidden="true">{bucket.label}</span>
          </div>
        )
      })}
    </div>
  )
}

function RankingValue({ plays, seconds }: { plays: number; seconds: number }) {
  return (
    <span className="listening-stats-ranking-values">
      <span>{formatCount(plays)}</span>
      <span>{formatExactDuration(seconds)}</span>
    </span>
  )
}

interface RankingCardProps<T> {
  title: string
  items: T[]
  emptyLabel: string
  getKey: (item: T) => string
  getTitle: (item: T) => string
  getSubtitle: (item: T) => string
  getArtworkHash: (item: T) => string | null
  getAvailable: (item: T) => boolean
  getPlays: (item: T) => number
  getSeconds: (item: T) => number
  onOpen: (item: T) => void
}

function RankingCard<T>({
  title,
  items,
  emptyLabel,
  getKey,
  getTitle,
  getSubtitle,
  getArtworkHash,
  getAvailable,
  getPlays,
  getSeconds,
  onOpen
}: RankingCardProps<T>) {
  return (
    <section className="listening-stats-ranking-card">
      <h2>{title}</h2>
      {items.length === 0 ? (
        <p className="listening-stats-ranking-empty">{emptyLabel}</p>
      ) : (
        <ol className="listening-stats-ranking-list">
          {items.map((item, index) => {
            const available = getAvailable(item)
            return (
              <li key={getKey(item)}>
                <button
                  className="listening-stats-ranking-row"
                  type="button"
                  disabled={!available}
                  onClick={() => onOpen(item)}
                  title={available ? translate('common:auto.statsview.open_value1', { value1: getTitle(item) }) : translate('common:auto.statsview.value1_is_no_longer_in_the_library', { value1: getTitle(item) })}
                >
                  <span className="listening-stats-ranking-position">{index + 1}</span>
                  <AlbumArtwork
                    hash={getArtworkHash(item)}
                    alt=""
                    className="listening-stats-ranking-artwork"
                    variant="thumbnail"
                  />
                  <span className="listening-stats-ranking-copy">
                    <span className="listening-stats-ranking-title">{getTitle(item)}</span>
                    <span className="listening-stats-ranking-subtitle">
                      {getSubtitle(item)}{available ? '' : translate('common:auto.statsview.removed_from_library')}
                    </span>
                  </span>
                  <RankingValue plays={getPlays(item)} seconds={getSeconds(item)} />
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

export default function StatsView() {
  const range = useListeningStatsStore((state) => state.range)
  const rankingMetric = useListeningStatsStore((state) => state.rankingMetric)
  const dashboard = useListeningStatsStore((state) => state.dashboard)
  const isLoading = useListeningStatsStore((state) => state.isLoading)
  const error = useListeningStatsStore((state) => state.error)
  const setRange = useListeningStatsStore((state) => state.setRange)
  const setRankingMetric = useListeningStatsStore((state) => state.setRankingMetric)
  const loadDashboard = useListeningStatsStore((state) => state.loadDashboard)
  const setActiveView = useUIStore((state) => state.setActiveView)
  const setLibraryViewMode = useLibraryStore((state) => state.setViewMode)
  const selectArtist = useLibraryStore((state) => state.selectArtist)
  const selectAlbum = useLibraryStore((state) => state.selectAlbum)
  const startPlaybackContextByPaths = usePlayerStore((state) => state.startPlaybackContextByPaths)
  const [shareSnapshot, setShareSnapshot] = useState<typeof dashboard>(null)

  useEffect(() => {
    void loadDashboard()
    const refreshInterval = window.setInterval(() => {
      void loadDashboard()
    }, 10_000)
    let checkpointRefreshTimeout: number | null = null
    const handleCheckpoint = () => {
      if (checkpointRefreshTimeout != null) window.clearTimeout(checkpointRefreshTimeout)
      checkpointRefreshTimeout = window.setTimeout(() => {
        checkpointRefreshTimeout = null
        void loadDashboard()
      }, 350)
    }
    window.addEventListener('astra:listening-history-checkpoint', handleCheckpoint)
    return () => {
      window.clearInterval(refreshInterval)
      window.removeEventListener('astra:listening-history-checkpoint', handleCheckpoint)
      if (checkpointRefreshTimeout != null) window.clearTimeout(checkpointRefreshTimeout)
    }
  }, [loadDashboard])

  const playableTrackPaths = useMemo(
    () => dashboard?.topTracks.flatMap((track) => track.available && track.trackPath ? [track.trackPath] : []) ?? [],
    [dashboard]
  )

  const handlePlayTrack = (track: ListeningStatsRankedTrack) => {
    if (!track.trackPath) return
    const index = playableTrackPaths.indexOf(track.trackPath)
    if (index < 0) return
    void startPlaybackContextByPaths(playableTrackPaths, index, { contextLabel: 'Listening Stats' })
  }

  const handleOpenArtist = (artist: ListeningStatsRankedArtist) => {
    setLibraryViewMode('artists')
    void selectArtist(artist.artist, 'library').then(() => setActiveView('library'))
  }

  const handleOpenAlbum = (album: ListeningStatsRankedAlbum) => {
    setLibraryViewMode('albums')
    void selectAlbum(album.album, album.artist, 'library', album.key).then(() => setActiveView('library'))
  }

  const hasDetailedHistory = dashboard?.status.startedAt != null
  const hasRangeActivity = Boolean(
    dashboard && (dashboard.summary.listenedSeconds > 0 || dashboard.summary.qualifiedPlays > 0)
  )

  return (
    <div className="listening-stats-view">
      <header className="listening-stats-header">
        <div>
          <p className="listening-stats-eyebrow"><LocalizedText ns="common" i18nKey="auto.statsview.your_library" /></p>
          <h1><LocalizedText ns="common" i18nKey="auto.statsview.listening_stats" /></h1>
          <p><LocalizedText ns="common" i18nKey="auto.statsview.local_listening_time_and_qualified_plays_from_this_insta" /></p>
        </div>
        <div className="listening-stats-header-actions">
          <button
            className="listening-stats-share-button"
            type="button"
            disabled={!dashboard || !hasDetailedHistory || !hasRangeActivity}
            title={hasRangeActivity ? translate('common:auto.statsview.create_a_shareable_listening_stats_image') : translate('common:auto.statsview.listen_to_something_in_this_range_before_sharing')}
            onClick={() => setShareSnapshot(dashboard)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4" />
            </svg>

            <LocalizedText ns="common" i18nKey="auto.statsview.share" />
          </button>
          <div className="listening-stats-range-control" role="group" aria-label={translate('common:auto.statsview.listening_stats_date_range')}>
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={range === option.value ? 'active' : ''}
                aria-pressed={range === option.value}
                onClick={() => setRange(option.value)}
              >
                {translateSourceText(option.label)}
              </button>
            ))}
          </div>
        </div>
      </header>

      {error && (
        <div className="listening-stats-state listening-stats-state-error" role="alert">
          <strong><LocalizedText ns="common" i18nKey="auto.statsview.listening_stats_could_not_be_loaded" /></strong>
          <span>{error}</span>
          <button type="button" onClick={() => void loadDashboard()}><LocalizedText ns="common" i18nKey="auto.statsview.try_again" /></button>
        </div>
      )}

      {!error && isLoading && !dashboard && (
        <div className="listening-stats-state" role="status"><LocalizedText ns="common" i18nKey="auto.statsview.loading_listening_history" /></div>
      )}

      {!error && dashboard && !hasDetailedHistory && (
        <div className="listening-stats-state">
          <strong><LocalizedText ns="common" i18nKey="auto.statsview.no_detailed_listening_history_yet" /></strong>
          <span><LocalizedText ns="common" i18nKey="auto.statsview.play_something_from_your_library_to_begin_existing_play_" /></span>
        </div>
      )}

      {!error && dashboard && hasDetailedHistory && (
        <>
          <p className="listening-stats-baseline">

            <LocalizedText ns="common" i18nKey="auto.statsview.detailed_history_since" /> {formatBaseline(dashboard.status.startedAt!)}
            {isLoading ? <span role="status">  <LocalizedText ns="common" i18nKey="auto.statsview.refreshing" /></span> : null}
          </p>

          <section className="listening-stats-summary" aria-label={translate('common:auto.statsview.listening_summary')}>
            <article>
              <span><LocalizedText ns="common" i18nKey="auto.statsview.listening_time" /></span>
              <strong>{formatExactDuration(dashboard.summary.listenedSeconds)}</strong>
            </article>
            <article>
              <span><LocalizedText ns="common" i18nKey="auto.statsview.qualified_plays" /></span>
              <strong>{formatLocaleNumber(dashboard.summary.qualifiedPlays)}</strong>
            </article>
            <article>
              <span><LocalizedText ns="common" i18nKey="auto.statsview.tracks_played" /></span>
              <strong>{formatLocaleNumber(dashboard.summary.tracksPlayed)}</strong>
            </article>
            <article>
              <span><LocalizedText ns="common" i18nKey="auto.statsview.active_days" /></span>
              <strong>{formatLocaleNumber(dashboard.summary.activeDays)}</strong>
            </article>
          </section>

          {!hasRangeActivity ? (
            <div className="listening-stats-state listening-stats-state-compact">
              <strong><LocalizedText ns="common" i18nKey="auto.statsview.no_listening_in_this_range" /></strong>
              <span><LocalizedText ns="common" i18nKey="auto.statsview.choose_another_range_or_start_playing_a_library_track" /></span>
            </div>
          ) : (
            <>
              <section className="listening-stats-activity-card">
                <div className="listening-stats-section-heading">
                  <div>
                    <p><LocalizedText ns="common" i18nKey="auto.statsview.activity" /></p>
                    <h2><LocalizedText ns="common" i18nKey="auto.statsview.listening_time" /></h2>
                  </div>
                  <span><LocalizedText ns="common" i18nKey="auto.statsview.focus_or_hover_a_bar_for_exact_time" /></span>
                </div>
                <ActivityChart key={dashboard.range} buckets={dashboard.activity} />
              </section>

              <div className="listening-stats-rankings-heading">
                <div>
                  <p><LocalizedText ns="common" i18nKey="auto.statsview.rankings" /></p>
                  <h2><LocalizedText ns="common" i18nKey="auto.statsview.your_top_listening" /></h2>
                </div>
                <div className="listening-stats-metric-control" role="group" aria-label={translate('common:auto.statsview.rank_listening_results_by')}>
                  <button
                    type="button"
                    className={rankingMetric === 'plays' ? 'active' : ''}
                    aria-pressed={rankingMetric === 'plays'}
                    onClick={() => setRankingMetric('plays')}
                  >

                    <LocalizedText ns="common" i18nKey="auto.statsview.plays" />
                  </button>
                  <button
                    type="button"
                    className={rankingMetric === 'time' ? 'active' : ''}
                    aria-pressed={rankingMetric === 'time'}
                    onClick={() => setRankingMetric('time')}
                  >

                    <LocalizedText ns="common" i18nKey="auto.statsview.time" />
                  </button>
                </div>
              </div>

              <div className="listening-stats-rankings-grid">
                <RankingCard
                  title={translate('common:auto.statsview.top_tracks')}
                  items={dashboard.topTracks}
                  emptyLabel="No tracks in this range."
                  getKey={(track) => track.key}
                  getTitle={(track) => track.title}
                  getSubtitle={(track) => `${track.artist} · ${track.album}`}
                  getArtworkHash={(track) => track.artworkHash}
                  getAvailable={(track) => track.available}
                  getPlays={(track) => track.qualifiedPlays}
                  getSeconds={(track) => track.listenedSeconds}
                  onOpen={handlePlayTrack}
                />
                <RankingCard
                  title={translate('common:auto.statsview.top_artists')}
                  items={dashboard.topArtists}
                  emptyLabel="No artists in this range."
                  getKey={(artist) => artist.key}
                  getTitle={(artist) => artist.artist}
                  getSubtitle={() => 'Artist'}
                  getArtworkHash={(artist) => artist.artworkHash}
                  getAvailable={(artist) => artist.available}
                  getPlays={(artist) => artist.qualifiedPlays}
                  getSeconds={(artist) => artist.listenedSeconds}
                  onOpen={handleOpenArtist}
                />
                <RankingCard
                  title={translate('common:auto.statsview.top_albums')}
                  items={dashboard.topAlbums}
                  emptyLabel="No albums in this range."
                  getKey={(album) => album.key}
                  getTitle={(album) => album.album}
                  getSubtitle={(album) => album.artist}
                  getArtworkHash={(album) => album.artworkHash}
                  getAvailable={(album) => album.available}
                  getPlays={(album) => album.qualifiedPlays}
                  getSeconds={(album) => album.listenedSeconds}
                  onOpen={handleOpenAlbum}
                />
              </div>
            </>
          )}
        </>
      )}

      <StatsShareModal
        isOpen={shareSnapshot !== null}
        snapshot={shareSnapshot}
        onClose={() => setShareSnapshot(null)}
      />
    </div>
  )
}
