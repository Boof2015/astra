import assert from 'node:assert/strict'
import test from 'node:test'
import type { ListeningHistoryStatus, ListeningStatsDashboard } from '../../types/listeningStats.ts'
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
