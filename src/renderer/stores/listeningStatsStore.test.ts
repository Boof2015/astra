import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  ListeningHistoryStatus,
  ListeningStatsDashboard,
  ListeningStatsQuery
} from '../../types/listeningStats.ts'
import { useLibraryStore } from './libraryStore.ts'
import { useListeningStatsStore } from './listeningStatsStore.ts'
import { usePlayerStore } from './playerStore.ts'

function emptyDashboard(overrides: Partial<ListeningStatsDashboard> = {}): ListeningStatsDashboard {
  return {
    status: { generation: 'generation-a', startedAt: null },
    range: '30d',
    rankingMetric: 'plays',
    rangeStartAt: null,
    rangeEndAt: 1,
    granularity: 'day',
    summary: { listenedSeconds: 0, qualifiedPlays: 0, tracksPlayed: 0, activeDays: 0 },
    activity: [],
    topTracks: [],
    topArtists: [],
    topAlbums: [],
    ...overrides
  }
}

test('Listening Stats defaults to 30D and play rankings', () => {
  useListeningStatsStore.setState({ range: '30d', rankingMetric: 'plays' })
  assert.equal(useListeningStatsStore.getState().range, '30d')
  assert.equal(useListeningStatsStore.getState().rankingMetric, 'plays')
})

test('dashboard requests include the current artist browse mode', async () => {
  const queries: ListeningStatsQuery[] = []
  const originalArtistBrowseMode = useLibraryStore.getState().artistBrowseMode
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        library: {
          getListeningStatsDashboard: async (query: ListeningStatsQuery) => {
            queries.push(query)
            return emptyDashboard({
              range: query.range,
              rankingMetric: query.rankingMetric
            })
          }
        }
      }
    }
  })

  try {
    useListeningStatsStore.setState({ range: '7d', rankingMetric: 'time' })
    useLibraryStore.setState({ artistBrowseMode: 'strict' })
    await useListeningStatsStore.getState().loadDashboard()
    useLibraryStore.setState({ artistBrowseMode: 'canonical' })
    await useListeningStatsStore.getState().loadDashboard()

    assert.deepEqual(queries, [
      { range: '7d', rankingMetric: 'time', artistBrowseMode: 'strict' },
      { range: '7d', rankingMetric: 'time', artistBrowseMode: 'canonical' }
    ])
  } finally {
    useLibraryStore.setState({ artistBrowseMode: originalArtistBrowseMode })
  }
})

test('clearing detailed history resets active player tracking generation and reloads an empty dashboard', async () => {
  const clearedStatus = { generation: 'generation-b', startedAt: null }
  let resetStatus: ListeningHistoryStatus | null = null
  const originalReset = usePlayerStore.getState().resetListeningHistoryTracking
  usePlayerStore.setState({
    resetListeningHistoryTracking: (status) => {
      resetStatus = status
    }
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        library: {
          clearDetailedListeningHistory: async () => clearedStatus,
          getListeningStatsDashboard: async () => emptyDashboard({ status: clearedStatus })
        }
      }
    }
  })

  try {
    useListeningStatsStore.setState({ dashboard: emptyDashboard(), error: 'old error' })
    const result = await useListeningStatsStore.getState().clearDetailedHistory()
    assert.deepEqual(result, clearedStatus)
    assert.deepEqual(resetStatus, clearedStatus)
    assert.deepEqual(useListeningStatsStore.getState().dashboard?.status, clearedStatus)
    assert.equal(useListeningStatsStore.getState().error, null)
  } finally {
    usePlayerStore.setState({ resetListeningHistoryTracking: originalReset })
  }
})
