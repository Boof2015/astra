import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildArtistGraph,
  resolveVisibleArtistGraph,
  type ArtistGraphTrackLike
} from './libraryGraph.ts'

function createTrack(id: string, overrides: Partial<ArtistGraphTrackLike> = {}): ArtistGraphTrackLike {
  return {
    path: `/music/${id}.flac`,
    title: overrides.title ?? `Track ${id}`,
    artist: overrides.artist ?? 'Artist One',
    artist_names: overrides.artist_names ?? null,
    album: overrides.album ?? 'Album One',
    album_artist: overrides.album_artist ?? null,
    album_artist_names: overrides.album_artist_names ?? null,
    album_identity_key: overrides.album_identity_key ?? `album:${overrides.album ?? 'Album One'}:${id}`,
    year: overrides.year ?? 2024,
    artwork_hash: overrides.artwork_hash ?? null
  }
}

test('buildArtistGraph counts shared tracks and shared releases correctly', () => {
  const graph = buildArtistGraph([
    createTrack('1', { artist: 'Alpha feat Beta', album: 'Shared Tape', album_identity_key: 'album:shared-tape' }),
    createTrack('2', { artist: 'Alpha ft. Beta', album: 'Shared Tape', album_identity_key: 'album:shared-tape' }),
    createTrack('3', { artist: 'Alpha with Beta', album: 'Encore', album_identity_key: 'album:encore' })
  ])

  assert.equal(graph.nodes.length, 2)
  assert.equal(graph.edges.length, 1)

  const edge = graph.edges[0]
  assert.equal(edge.sharedTrackCount, 3)
  assert.equal(edge.sharedReleaseCount, 2)
  assert.equal(edge.source, 'alpha')
  assert.equal(edge.target, 'beta')
})

test('buildArtistGraph collapses duplicate artist mentions and avoids self-links', () => {
  const graph = buildArtistGraph([
    createTrack('solo', {
      artist: 'Solo Artist',
      album_artist: 'Solo Artist',
      album_identity_key: 'album:solo-artist'
    })
  ])

  assert.equal(graph.nodes.length, 1)
  assert.equal(graph.nodes[0]?.artist, 'Solo Artist')
  assert.equal(graph.edges.length, 0)
})

test('buildArtistGraph uses parsed artist credits without splitting names that contain separators', () => {
  const graph = buildArtistGraph([
    createTrack('parsed-collab', {
      artist: 'Earth, Wind & Fire & The Emotions',
      artist_names: ['Earth, Wind & Fire', 'The Emotions'],
      album_identity_key: 'album:parsed-collab'
    })
  ])

  assert.deepEqual(graph.nodes.map((node) => node.artist).sort(), ['Earth, Wind & Fire', 'The Emotions'])
  assert.equal(graph.edges.length, 1)
})

test('buildArtistGraph tolerates missing metadata and falls back to Unknown Artist', () => {
  const graph = buildArtistGraph([
    createTrack('missing', {
      artist: '',
      album: '',
      album_identity_key: ''
    })
  ])

  assert.equal(graph.nodes.length, 1)
  assert.equal(graph.nodes[0]?.artist, 'Unknown Artist')
  assert.equal(graph.edges.length, 0)
})

test('buildArtistGraph ignores Various Artists credits while keeping real collaborators', () => {
  const graph = buildArtistGraph([
    createTrack('collab', {
      artist: 'Alpha feat Beta',
      album_artist: 'Various Artists',
      album_identity_key: 'album:collab'
    }),
    createTrack('generic-only', {
      artist: 'Various Artists',
      album_artist: 'Various Artists',
      album_identity_key: 'album:generic-only'
    })
  ])

  assert.deepEqual(graph.nodes.map((node) => node.artist).sort(), ['Alpha', 'Beta'])
  assert.equal(graph.edges.length, 1)
  assert.equal(graph.edges[0]?.source, 'alpha')
  assert.equal(graph.edges[0]?.target, 'beta')
})

test('resolveVisibleArtistGraph applies full-view thresholds and focus-view neighbor limits', () => {
  const graph = buildArtistGraph([
    createTrack('ab-1', { artist: 'A feat B', album_identity_key: 'album:ab-1' }),
    createTrack('ab-2', { artist: 'A feat B', album_identity_key: 'album:ab-2' }),
    createTrack('ac-1', { artist: 'A feat C', album_identity_key: 'album:ac-1' }),
    createTrack('ad-1', { artist: 'A feat D', album_identity_key: 'album:ad-1' })
  ])

  const full = resolveVisibleArtistGraph(graph, {
    mode: 'full',
    edgeWeightThreshold: 2,
    fullMaxNeighborsPerNode: 8
  })
  assert.deepEqual(full.nodes.map((node) => node.artist).sort(), ['A', 'B'])
  assert.equal(full.edges.length, 1)
  assert.equal(full.effectiveEdgeThreshold, 2)

  const focus = resolveVisibleArtistGraph(graph, {
    mode: 'focus',
    focusArtistKey: 'a',
    edgeWeightThreshold: 1,
    focusNeighborLimit: 1
  })
  assert.deepEqual(focus.nodes.map((node) => node.artist).sort(), ['A', 'B'])
  assert.equal(focus.hiddenFocusNeighborCount, 2)
})
