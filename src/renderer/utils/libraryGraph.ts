import {
  buildAlbumIdentityKeyFromTrack,
  normalizeDisplay,
  normalizeKey,
  splitCollaborators
} from './albumIdentity.ts'
import { normalizeArtistNames } from '../../shared/library/artistCredits.ts'

const UNKNOWN_ARTIST_NAME = 'Unknown Artist'
const UNKNOWN_ALBUM_NAME = 'Unknown Album'
const GENERIC_ARTIST_KEYS = new Set(['various artists', 'various artist', 'va', 'v a'])
const DEFAULT_FULL_GRAPH_MAX_NEIGHBORS = 8
const DEFAULT_FOCUS_GRAPH_NEIGHBOR_LIMIT = 8
const MAX_EDGE_SAMPLE_TRACKS = 6
const MAX_EDGE_SAMPLE_RELEASES = 4
const MAX_STRONGEST_COLLABORATORS = 8

export interface ArtistGraphTrackLike {
  path: string
  title: string
  artist: string
  artist_names?: string[] | null
  album: string
  album_artist?: string | null
  album_artist_names?: string[] | null
  album_identity_key?: string | null
  year?: number | null
  artwork_hash?: string | null
}

export interface ArtistGraphSharedTrack {
  path: string
  title: string
  album: string
  albumIdentityKey: string
  year: number | null
}

export interface ArtistGraphSharedRelease {
  identityKey: string
  album: string
  year: number | null
}

export interface ArtistGraphNeighborSummary {
  artistKey: string
  artist: string
  edgeKey: string
  sharedTrackCount: number
  sharedReleaseCount: number
}

export interface ArtistGraphNode {
  key: string
  artist: string
  trackCount: number
  collaboratorCount: number
  artworkHash: string | null
  strongestCollaborators: ArtistGraphNeighborSummary[]
}

export interface ArtistGraphEdge {
  key: string
  source: string
  target: string
  sharedTrackCount: number
  sharedReleaseCount: number
  sampleTracks: ArtistGraphSharedTrack[]
  sampleReleases: ArtistGraphSharedRelease[]
}

export interface ArtistGraphBuildResult {
  nodes: ArtistGraphNode[]
  edges: ArtistGraphEdge[]
  maxTrackCount: number
  maxEdgeWeight: number
}

export interface ArtistGraphIndex {
  nodeByKey: Map<string, ArtistGraphNode>
  edgeByKey: Map<string, ArtistGraphEdge>
  neighborsByArtistKey: Map<string, ArtistGraphNeighborSummary[]>
}

export interface ArtistGraphVisibleResult {
  nodes: ArtistGraphNode[]
  edges: ArtistGraphEdge[]
  focusArtistKey: string | null
  hiddenFocusNeighborCount: number
  effectiveEdgeThreshold: number
}

export interface ArtistGraphVisibleOptions {
  mode: 'full' | 'focus'
  focusArtistKey?: string | null
  edgeWeightThreshold?: number
  fullMaxNeighborsPerNode?: number
  focusNeighborLimit?: number
}

export interface ArtistGraphLayoutNode {
  key: string
  x: number
  y: number
  revealOrder: number
}

export interface ArtistGraphLayoutEdge {
  key: string
  revealOrder: number
}

export interface ArtistGraphLayoutResult {
  nodes: ArtistGraphLayoutNode[]
  edges: ArtistGraphLayoutEdge[]
  bounds: {
    minX: number
    maxX: number
    minY: number
    maxY: number
  }
}

interface ArtistGraphNodeAccumulator {
  key: string
  displayVariants: Map<string, number>
  trackCount: number
  artworkHash: string | null
}

interface ArtistGraphEdgeAccumulator {
  key: string
  source: string
  target: string
  sharedTrackCount: number
  releaseKeys: Set<string>
  sampleTrackKeys: Set<string>
  sampleTracks: ArtistGraphSharedTrack[]
  sampleReleasesByKey: Map<string, ArtistGraphSharedRelease>
}

interface ArtistGraphPlacementComponent {
  nodes: ArtistGraphLayoutNode[]
  diameter: number
}

interface ArtistGraphPlacedComponent {
  nodes: ArtistGraphLayoutNode[]
  diameter: number
  x: number
  y: number
  radius: number
}

interface RelaxLayoutOptions {
  fixedNodeKeys?: Set<string>
}

const artistGraphBuildCache = new WeakMap<readonly ArtistGraphTrackLike[], ArtistGraphBuildResult>()
const artistGraphIndexCache = new WeakMap<ArtistGraphBuildResult, ArtistGraphIndex>()
const artistGraphVisibleCache = new WeakMap<ArtistGraphBuildResult, Map<string, ArtistGraphVisibleResult>>()
const artistGraphLayoutCache = new WeakMap<ArtistGraphVisibleResult, Map<string, ArtistGraphLayoutResult>>()

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function hashStringToUnit(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash * 31) + value.charCodeAt(index)) >>> 0
  }

  return hash / 0xffffffff
}

function isIgnorableArtist(displayArtist: string): boolean {
  const artistKey = normalizeKey(displayArtist)
  return artistKey != null && GENERIC_ARTIST_KEYS.has(artistKey)
}

function toTrackParticipants(track: ArtistGraphTrackLike): Map<string, string> {
  const participants = new Map<string, string>()
  let sawIgnorableArtist = false

  const addParticipants = (rawValue: string | null | undefined) => {
    const normalized = normalizeDisplay(rawValue ?? '')
    if (!normalized) return

    const split = splitCollaborators(normalized)
    const values = split.length > 0 ? split : [normalized]
    for (const value of values) {
      const display = normalizeDisplay(value)
      if (!display) continue
      if (isIgnorableArtist(display)) {
        sawIgnorableArtist = true
        continue
      }
      const key = normalizeKey(display)
      if (!key || participants.has(key)) continue
      participants.set(key, display)
    }
  }

  const addParticipantNames = (rawNames: readonly unknown[] | null | undefined): boolean => {
    const names = normalizeArtistNames(rawNames)
    if (names.length === 0) return false

    for (const name of names) {
      const display = normalizeDisplay(name)
      if (!display) continue
      if (isIgnorableArtist(display)) {
        sawIgnorableArtist = true
        continue
      }
      const key = normalizeKey(display)
      if (!key || participants.has(key)) continue
      participants.set(key, display)
    }
    return true
  }

  if (!addParticipantNames(track.album_artist_names)) addParticipants(track.album_artist)
  if (!addParticipantNames(track.artist_names)) addParticipants(track.artist)

  if (participants.size === 0 && !sawIgnorableArtist) {
    participants.set(normalizeKey(UNKNOWN_ARTIST_NAME), UNKNOWN_ARTIST_NAME)
  }

  return participants
}

function getReleaseIdentityKey(track: ArtistGraphTrackLike): string {
  const explicitKey = normalizeDisplay(track.album_identity_key ?? '')
  if (explicitKey) return explicitKey
  return buildAlbumIdentityKeyFromTrack(track)
}

function getTrackAlbumName(track: ArtistGraphTrackLike): string {
  return normalizeDisplay(track.album) || UNKNOWN_ALBUM_NAME
}

function getTrackTitle(track: ArtistGraphTrackLike): string {
  return normalizeDisplay(track.title) || track.path.split('/').pop() || track.path
}

function getMostFrequentDisplayVariant(variants: Map<string, number>, fallback: string): string {
  let selected = fallback
  let selectedCount = -1

  for (const [display, count] of variants.entries()) {
    if (count > selectedCount) {
      selected = display
      selectedCount = count
      continue
    }
    if (count === selectedCount && display.localeCompare(selected, undefined, { sensitivity: 'base' }) < 0) {
      selected = display
    }
  }

  return selected
}

function compareNeighborSummary(left: ArtistGraphNeighborSummary, right: ArtistGraphNeighborSummary): number {
  if (left.sharedTrackCount !== right.sharedTrackCount) {
    return right.sharedTrackCount - left.sharedTrackCount
  }
  if (left.sharedReleaseCount !== right.sharedReleaseCount) {
    return right.sharedReleaseCount - left.sharedReleaseCount
  }
  return left.artist.localeCompare(right.artist, undefined, { sensitivity: 'base' })
}

function compareNode(left: ArtistGraphNode, right: ArtistGraphNode): number {
  if (left.trackCount !== right.trackCount) {
    return right.trackCount - left.trackCount
  }
  if (left.collaboratorCount !== right.collaboratorCount) {
    return right.collaboratorCount - left.collaboratorCount
  }
  return left.artist.localeCompare(right.artist, undefined, { sensitivity: 'base' })
}

function compareEdge(left: ArtistGraphEdge, right: ArtistGraphEdge): number {
  if (left.sharedTrackCount !== right.sharedTrackCount) {
    return right.sharedTrackCount - left.sharedTrackCount
  }
  if (left.sharedReleaseCount !== right.sharedReleaseCount) {
    return right.sharedReleaseCount - left.sharedReleaseCount
  }
  return left.key.localeCompare(right.key)
}

function getVisibleCacheKey(options: ArtistGraphVisibleOptions): string {
  const edgeWeightThreshold = Math.max(1, options.edgeWeightThreshold ?? 2)
  if (options.mode === 'focus') {
    const focusNeighborLimit = Math.max(1, options.focusNeighborLimit ?? DEFAULT_FOCUS_GRAPH_NEIGHBOR_LIMIT)
    return `focus:${options.focusArtistKey ?? ''}:${edgeWeightThreshold}:${focusNeighborLimit}`
  }

  const fullMaxNeighborsPerNode = Math.max(1, options.fullMaxNeighborsPerNode ?? DEFAULT_FULL_GRAPH_MAX_NEIGHBORS)
  return `full:${edgeWeightThreshold}:${fullMaxNeighborsPerNode}`
}

function buildNeighborMap(graph: ArtistGraphBuildResult): Map<string, ArtistGraphNeighborSummary[]> {
  const nodeByKey = new Map(graph.nodes.map((node) => [node.key, node]))
  const neighborsByArtistKey = new Map<string, ArtistGraphNeighborSummary[]>()

  const appendNeighbor = (
    artistKey: string,
    neighborArtistKey: string,
    edge: ArtistGraphEdge
  ) => {
    const list = neighborsByArtistKey.get(artistKey)
    const neighborNode = nodeByKey.get(neighborArtistKey)
    const summary: ArtistGraphNeighborSummary = {
      artistKey: neighborArtistKey,
      artist: neighborNode?.artist ?? neighborArtistKey,
      edgeKey: edge.key,
      sharedTrackCount: edge.sharedTrackCount,
      sharedReleaseCount: edge.sharedReleaseCount
    }

    if (list) {
      list.push(summary)
    } else {
      neighborsByArtistKey.set(artistKey, [summary])
    }
  }

  for (const edge of graph.edges) {
    appendNeighbor(edge.source, edge.target, edge)
    appendNeighbor(edge.target, edge.source, edge)
  }

  for (const list of neighborsByArtistKey.values()) {
    list.sort(compareNeighborSummary)
  }

  return neighborsByArtistKey
}

export function indexArtistGraph(graph: ArtistGraphBuildResult): ArtistGraphIndex {
  const cached = artistGraphIndexCache.get(graph)
  if (cached) {
    return cached
  }

  const index = {
    nodeByKey: new Map(graph.nodes.map((node) => [node.key, node])),
    edgeByKey: new Map(graph.edges.map((edge) => [edge.key, edge])),
    neighborsByArtistKey: buildNeighborMap(graph)
  }

  artistGraphIndexCache.set(graph, index)
  return index
}

export function buildArtistGraph(tracks: readonly ArtistGraphTrackLike[]): ArtistGraphBuildResult {
  const cached = artistGraphBuildCache.get(tracks)
  if (cached) {
    return cached
  }

  const nodeAccumulators = new Map<string, ArtistGraphNodeAccumulator>()
  const edgeAccumulators = new Map<string, ArtistGraphEdgeAccumulator>()

  for (const track of tracks) {
    const participants = toTrackParticipants(track)
    const participantEntries = Array.from(participants.entries())
    const releaseIdentityKey = getReleaseIdentityKey(track)
    const albumName = getTrackAlbumName(track)
    const sampleTrack: ArtistGraphSharedTrack = {
      path: track.path,
      title: getTrackTitle(track),
      album: albumName,
      albumIdentityKey: releaseIdentityKey,
      year: track.year ?? null
    }
    const sampleRelease: ArtistGraphSharedRelease = {
      identityKey: releaseIdentityKey,
      album: albumName,
      year: track.year ?? null
    }

    for (const [artistKey, displayArtist] of participantEntries) {
      let node = nodeAccumulators.get(artistKey)
      if (!node) {
        node = {
          key: artistKey,
          displayVariants: new Map(),
          trackCount: 0,
          artworkHash: null
        }
        nodeAccumulators.set(artistKey, node)
      }

      node.trackCount += 1
      node.displayVariants.set(displayArtist, (node.displayVariants.get(displayArtist) ?? 0) + 1)
      if (!node.artworkHash && track.artwork_hash) {
        node.artworkHash = track.artwork_hash
      }
    }

    participantEntries.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    for (let leftIndex = 0; leftIndex < participantEntries.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < participantEntries.length; rightIndex += 1) {
        const leftArtistKey = participantEntries[leftIndex]?.[0]
        const rightArtistKey = participantEntries[rightIndex]?.[0]
        if (!leftArtistKey || !rightArtistKey || leftArtistKey === rightArtistKey) continue

        const edgeKey = `${leftArtistKey}::${rightArtistKey}`
        let edge = edgeAccumulators.get(edgeKey)
        if (!edge) {
          edge = {
            key: edgeKey,
            source: leftArtistKey,
            target: rightArtistKey,
            sharedTrackCount: 0,
            releaseKeys: new Set(),
            sampleTrackKeys: new Set(),
            sampleTracks: [],
            sampleReleasesByKey: new Map()
          }
          edgeAccumulators.set(edgeKey, edge)
        }

        edge.sharedTrackCount += 1
        if (!edge.releaseKeys.has(releaseIdentityKey)) {
          edge.releaseKeys.add(releaseIdentityKey)
          if (edge.sampleReleasesByKey.size < MAX_EDGE_SAMPLE_RELEASES) {
            edge.sampleReleasesByKey.set(releaseIdentityKey, sampleRelease)
          }
        }
        if (!edge.sampleTrackKeys.has(track.path) && edge.sampleTracks.length < MAX_EDGE_SAMPLE_TRACKS) {
          edge.sampleTrackKeys.add(track.path)
          edge.sampleTracks.push(sampleTrack)
        }
      }
    }
  }

  const provisionalNodes = new Map<string, ArtistGraphNode>()
  for (const accumulator of nodeAccumulators.values()) {
    const fallbackArtist = getMostFrequentDisplayVariant(accumulator.displayVariants, UNKNOWN_ARTIST_NAME)
    provisionalNodes.set(accumulator.key, {
      key: accumulator.key,
      artist: fallbackArtist,
      trackCount: accumulator.trackCount,
      collaboratorCount: 0,
      artworkHash: accumulator.artworkHash,
      strongestCollaborators: []
    })
  }

  const edges = Array.from(edgeAccumulators.values()).map<ArtistGraphEdge>((accumulator) => ({
    key: accumulator.key,
    source: accumulator.source,
    target: accumulator.target,
    sharedTrackCount: accumulator.sharedTrackCount,
    sharedReleaseCount: accumulator.releaseKeys.size,
    sampleTracks: accumulator.sampleTracks.slice(),
    sampleReleases: Array.from(accumulator.sampleReleasesByKey.values())
  })).sort(compareEdge)

  const neighborBuckets = new Map<string, ArtistGraphNeighborSummary[]>()
  const appendNeighborSummary = (artistKey: string, neighborArtistKey: string, edge: ArtistGraphEdge) => {
    const currentNode = provisionalNodes.get(neighborArtistKey)
    const summary: ArtistGraphNeighborSummary = {
      artistKey: neighborArtistKey,
      artist: currentNode?.artist ?? neighborArtistKey,
      edgeKey: edge.key,
      sharedTrackCount: edge.sharedTrackCount,
      sharedReleaseCount: edge.sharedReleaseCount
    }

    const bucket = neighborBuckets.get(artistKey)
    if (bucket) {
      bucket.push(summary)
    } else {
      neighborBuckets.set(artistKey, [summary])
    }
  }

  for (const edge of edges) {
    appendNeighborSummary(edge.source, edge.target, edge)
    appendNeighborSummary(edge.target, edge.source, edge)
  }

  const nodes = Array.from(provisionalNodes.values()).map<ArtistGraphNode>((node) => {
    const collaborators = neighborBuckets.get(node.key) ?? []
    collaborators.sort(compareNeighborSummary)
    return {
      ...node,
      collaboratorCount: collaborators.length,
      strongestCollaborators: collaborators.slice(0, MAX_STRONGEST_COLLABORATORS)
    }
  }).sort(compareNode)

  const result = {
    nodes,
    edges,
    maxTrackCount: nodes.reduce((maxTrackCount, node) => Math.max(maxTrackCount, node.trackCount), 0),
    maxEdgeWeight: edges.reduce((maxEdgeWeight, edge) => Math.max(maxEdgeWeight, edge.sharedTrackCount), 0)
  }

  artistGraphBuildCache.set(tracks, result)
  return result
}

export function resolveVisibleArtistGraph(
  graph: ArtistGraphBuildResult,
  options: ArtistGraphVisibleOptions
): ArtistGraphVisibleResult {
  const cacheKey = getVisibleCacheKey(options)
  const cachedVisibleGraphs = artistGraphVisibleCache.get(graph)
  const cached = cachedVisibleGraphs?.get(cacheKey)
  if (cached) {
    return cached
  }

  const { nodeByKey, edgeByKey, neighborsByArtistKey } = indexArtistGraph(graph)
  const mode = options.mode

  if (mode === 'focus') {
    const focusNeighborLimit = Math.max(1, options.focusNeighborLimit ?? DEFAULT_FOCUS_GRAPH_NEIGHBOR_LIMIT)
    const preferredThreshold = Math.max(1, options.edgeWeightThreshold ?? 2)
    const focusArtistKey = options.focusArtistKey && nodeByKey.has(options.focusArtistKey)
      ? options.focusArtistKey
      : graph.nodes[0]?.key ?? null

    if (!focusArtistKey) {
      const emptyResult = {
        nodes: [],
        edges: [],
        focusArtistKey: null,
        hiddenFocusNeighborCount: 0,
        effectiveEdgeThreshold: 1
      }
      const nextCache = cachedVisibleGraphs ?? new Map<string, ArtistGraphVisibleResult>()
      nextCache.set(cacheKey, emptyResult)
      if (!cachedVisibleGraphs) {
        artistGraphVisibleCache.set(graph, nextCache)
      }
      return emptyResult
    }

    const allNeighbors = neighborsByArtistKey.get(focusArtistKey) ?? []
    let effectiveEdgeThreshold = preferredThreshold
    let eligibleNeighbors = allNeighbors.filter((neighbor) => neighbor.sharedTrackCount >= preferredThreshold)

    if (eligibleNeighbors.length === 0 && preferredThreshold > 1 && allNeighbors.length > 0) {
      effectiveEdgeThreshold = 1
      eligibleNeighbors = allNeighbors.filter((neighbor) => neighbor.sharedTrackCount >= 1)
    }

    const visibleArtistKeys = new Set<string>([focusArtistKey])
    for (const neighbor of eligibleNeighbors.slice(0, focusNeighborLimit)) {
      visibleArtistKeys.add(neighbor.artistKey)
    }

    const visibleEdges = graph.edges.filter((edge) => (
      edge.sharedTrackCount >= effectiveEdgeThreshold &&
      visibleArtistKeys.has(edge.source) &&
      visibleArtistKeys.has(edge.target)
    ))
    const visibleNodes = graph.nodes.filter((node) => visibleArtistKeys.has(node.key))

    const result = {
      nodes: visibleNodes,
      edges: visibleEdges,
      focusArtistKey,
      hiddenFocusNeighborCount: Math.max(0, eligibleNeighbors.length - (visibleArtistKeys.size - 1)),
      effectiveEdgeThreshold
    }
    const nextCache = cachedVisibleGraphs ?? new Map<string, ArtistGraphVisibleResult>()
    nextCache.set(cacheKey, result)
    if (!cachedVisibleGraphs) {
      artistGraphVisibleCache.set(graph, nextCache)
    }
    return result
  }

  const preferredThreshold = Math.max(1, options.edgeWeightThreshold ?? 2)
  let effectiveEdgeThreshold = preferredThreshold
  let eligibleEdges = graph.edges.filter((edge) => edge.sharedTrackCount >= preferredThreshold)

  if (eligibleEdges.length === 0 && preferredThreshold > 1 && graph.edges.length > 0) {
    effectiveEdgeThreshold = 1
    eligibleEdges = graph.edges.filter((edge) => edge.sharedTrackCount >= 1)
  }

  const fullMaxNeighborsPerNode = Math.max(1, options.fullMaxNeighborsPerNode ?? DEFAULT_FULL_GRAPH_MAX_NEIGHBORS)
  const selectedEdgeKeys = new Set<string>()

  for (const node of graph.nodes) {
    const neighbors = (neighborsByArtistKey.get(node.key) ?? [])
      .filter((neighbor) => {
        const edge = edgeByKey.get(neighbor.edgeKey)
        return edge != null && edge.sharedTrackCount >= effectiveEdgeThreshold
      })
      .slice(0, fullMaxNeighborsPerNode)

    for (const neighbor of neighbors) {
      selectedEdgeKeys.add(neighbor.edgeKey)
    }
  }

  const visibleEdges = eligibleEdges.filter((edge) => selectedEdgeKeys.has(edge.key))
  const visibleArtistKeys = new Set<string>()
  for (const edge of visibleEdges) {
    visibleArtistKeys.add(edge.source)
    visibleArtistKeys.add(edge.target)
  }

  const result = {
    nodes: graph.nodes.filter((node) => visibleArtistKeys.has(node.key)),
    edges: visibleEdges,
    focusArtistKey: null,
    hiddenFocusNeighborCount: 0,
    effectiveEdgeThreshold
  }
  const nextCache = cachedVisibleGraphs ?? new Map<string, ArtistGraphVisibleResult>()
  nextCache.set(cacheKey, result)
  if (!cachedVisibleGraphs) {
    artistGraphVisibleCache.set(graph, nextCache)
  }
  return result
}

function buildFocusLayout(
  visibleGraph: ArtistGraphVisibleResult,
  graphIndex: ArtistGraphIndex
): ArtistGraphLayoutResult {
  const focusArtistKey = visibleGraph.focusArtistKey
  if (!focusArtistKey) {
    return {
      nodes: [],
      edges: [],
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 }
    }
  }

  const layoutNodes: ArtistGraphLayoutNode[] = [{
    key: focusArtistKey,
    x: 0,
    y: 0,
    revealOrder: 0
  }]
  const focusNeighbors = (graphIndex.neighborsByArtistKey.get(focusArtistKey) ?? [])
    .filter((neighbor) => visibleGraph.nodes.some((node) => node.key === neighbor.artistKey))
  let revealOrder = 1
  const angleSeed = hashStringToUnit(focusArtistKey) * Math.PI * 2
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))

  for (let index = 0; index < focusNeighbors.length; index += 1) {
    const neighbor = focusNeighbors[index]
    if (!neighbor) continue

    const angleJitter = (hashStringToUnit(`${neighbor.artistKey}:focus-angle`) - 0.5) * 0.42
    const radiusJitter = (hashStringToUnit(`${neighbor.artistKey}:focus-radius`) - 0.5) * 30
    const radius = 176 + (Math.sqrt(index + 1) * 58) - (Math.min(neighbor.sharedTrackCount, 6) * 10) + radiusJitter
    const angle = angleSeed + (index * goldenAngle) + angleJitter

    layoutNodes.push({
      key: neighbor.artistKey,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      revealOrder
    })
    revealOrder += 1
  }

  const relaxedNodes = relaxArtistGraphLayout(layoutNodes, visibleGraph.edges, {
    fixedNodeKeys: new Set<string>([focusArtistKey])
  })
  const nodeRevealOrderByKey = new Map(relaxedNodes.map((node) => [node.key, node.revealOrder]))
  const layoutEdges = visibleGraph.edges.map<ArtistGraphLayoutEdge>((edge) => ({
    key: edge.key,
    revealOrder: Math.max(
      nodeRevealOrderByKey.get(edge.source) ?? 0,
      nodeRevealOrderByKey.get(edge.target) ?? 0
    )
  }))

  return {
    nodes: relaxedNodes,
    edges: layoutEdges,
    bounds: computeLayoutBounds(relaxedNodes)
  }
}

function buildConnectedComponents(
  visibleGraph: ArtistGraphVisibleResult
): string[][] {
  const adjacency = new Map<string, Set<string>>()
  const unseen = new Set(visibleGraph.nodes.map((node) => node.key))

  for (const node of visibleGraph.nodes) {
    adjacency.set(node.key, new Set())
  }
  for (const edge of visibleGraph.edges) {
    adjacency.get(edge.source)?.add(edge.target)
    adjacency.get(edge.target)?.add(edge.source)
  }

  const components: string[][] = []
  while (unseen.size > 0) {
    const iterator = unseen.values().next()
    const root = iterator.value
    if (!root) break

    const component: string[] = []
    const queue = [root]
    unseen.delete(root)

    while (queue.length > 0) {
      const current = queue.shift()
      if (!current) continue
      component.push(current)

      for (const neighbor of adjacency.get(current) ?? []) {
        if (!unseen.has(neighbor)) continue
        unseen.delete(neighbor)
        queue.push(neighbor)
      }
    }

    components.push(component)
  }

  return components
}

function buildComponentLayout(
  componentArtistKeys: string[],
  graphIndex: ArtistGraphIndex,
  revealOrderSeed: number
): ArtistGraphPlacementComponent {
  const componentKeySet = new Set(componentArtistKeys)
  const degreeOf = (artistKey: string) => (
    graphIndex.neighborsByArtistKey.get(artistKey)?.filter((neighbor) => componentKeySet.has(neighbor.artistKey)).length ?? 0
  )

  const rootKey = componentArtistKeys
    .slice()
    .sort((left, right) => {
      const leftNode = graphIndex.nodeByKey.get(left)
      const rightNode = graphIndex.nodeByKey.get(right)
      const degreeDelta = degreeOf(right) - degreeOf(left)
      if (degreeDelta !== 0) return degreeDelta
      const trackDelta = (rightNode?.trackCount ?? 0) - (leftNode?.trackCount ?? 0)
      if (trackDelta !== 0) return trackDelta
      return (leftNode?.artist ?? left).localeCompare(rightNode?.artist ?? right, undefined, { sensitivity: 'base' })
    })[0]

  if (!rootKey) {
    return { nodes: [], diameter: 0 }
  }

  const layoutNodes: ArtistGraphLayoutNode[] = []
  const nodeByKey = new Map<string, ArtistGraphLayoutNode>()
  let revealOrder = revealOrderSeed
  const rootNode: ArtistGraphLayoutNode = {
    key: rootKey,
    x: 0,
    y: 0,
    revealOrder
  }
  layoutNodes.push(rootNode)
  nodeByKey.set(rootKey, rootNode)
  revealOrder += 1

  const placedKeys = new Set<string>([rootKey])
  const depthByKey = new Map<string, number>([[rootKey, 0]])
  const queue = [rootKey]

  while (queue.length > 0) {
    const currentKey = queue.shift()
    if (!currentKey) continue

    const currentNode = nodeByKey.get(currentKey)
    if (!currentNode) continue

    const depth = depthByKey.get(currentKey) ?? 0
    const neighbors = (graphIndex.neighborsByArtistKey.get(currentKey) ?? [])
      .filter((neighbor) => componentKeySet.has(neighbor.artistKey) && !placedKeys.has(neighbor.artistKey))

    const branchBaseAngle = currentKey === rootKey
      ? hashStringToUnit(`${currentKey}:branch`) * Math.PI * 2
      : Math.atan2(currentNode.y, currentNode.x) + Math.PI + ((hashStringToUnit(`${currentKey}:branch`) - 0.5) * 1.4)

    for (let index = 0; index < neighbors.length; index += 1) {
      const neighbor = neighbors[index]
      if (!neighbor) continue

      const preferredAngle = branchBaseAngle
        + ((index - ((neighbors.length - 1) / 2)) * 0.62)
        + ((hashStringToUnit(`${currentKey}:${neighbor.artistKey}:angle`) - 0.5) * 0.36)
      const preferredRadius = 138
        + (depth * 54)
        + (Math.max(0, 5 - Math.min(neighbor.sharedTrackCount, 5)) * 10)
        + ((index % 3) * 12)

      let placedNode: ArtistGraphLayoutNode | null = null
      for (let attempt = 0; attempt < 18; attempt += 1) {
        const angle = preferredAngle + ((attempt % 6) * 0.38) - 1.14
        const radius = preferredRadius + (Math.floor(attempt / 3) * 26)
        const candidateX = currentNode.x + (Math.cos(angle) * radius)
        const candidateY = currentNode.y + (Math.sin(angle) * radius)

        let nearestDistance = Number.POSITIVE_INFINITY
        for (const existingNode of layoutNodes) {
          const dx = existingNode.x - candidateX
          const dy = existingNode.y - candidateY
          nearestDistance = Math.min(nearestDistance, Math.sqrt((dx * dx) + (dy * dy)))
        }

        if (nearestDistance > (depth === 0 ? 104 : 94)) {
          placedNode = {
            key: neighbor.artistKey,
            x: candidateX,
            y: candidateY,
            revealOrder
          }
          break
        }
      }

      if (!placedNode) {
        const fallbackAngle = preferredAngle + ((hashStringToUnit(`${neighbor.artistKey}:fallback`) - 0.5) * 0.8)
        const fallbackRadius = preferredRadius + 80
        placedNode = {
          key: neighbor.artistKey,
          x: currentNode.x + (Math.cos(fallbackAngle) * fallbackRadius),
          y: currentNode.y + (Math.sin(fallbackAngle) * fallbackRadius),
          revealOrder
        }
      }

      layoutNodes.push(placedNode)
      nodeByKey.set(neighbor.artistKey, placedNode)
      placedKeys.add(neighbor.artistKey)
      depthByKey.set(neighbor.artistKey, depth + 1)
      queue.push(neighbor.artistKey)
      revealOrder += 1
    }
  }

  for (const artistKey of componentArtistKeys) {
    if (placedKeys.has(artistKey)) continue

    const angle = hashStringToUnit(`${artistKey}:orphan`) * Math.PI * 2
    const radius = 220 + (placedKeys.size * 10)
    const fallbackNode: ArtistGraphLayoutNode = {
      key: artistKey,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      revealOrder
    }
    layoutNodes.push(fallbackNode)
    nodeByKey.set(artistKey, fallbackNode)
    placedKeys.add(artistKey)
    revealOrder += 1
  }

  const relaxedNodes = relaxArtistGraphLayout(
    layoutNodes,
    Array.from(graphIndex.edgeByKey.values()).filter((edge) => componentKeySet.has(edge.source) && componentKeySet.has(edge.target)),
    { fixedNodeKeys: new Set<string>([rootKey]) }
  )

  const bounds = computeLayoutBounds(relaxedNodes)
  const diameter = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)

  return {
    nodes: relaxedNodes,
    diameter
  }
}

function placeComponentsOnField(components: ArtistGraphPlacementComponent[]): ArtistGraphLayoutNode[] {
  if (components.length === 0) {
    return []
  }

  const placedComponents: ArtistGraphPlacedComponent[] = []
  const mergedNodes: ArtistGraphLayoutNode[] = []
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))
  const fieldCompression = 0.76

  for (let index = 0; index < components.length; index += 1) {
    const component = components[index]
    if (!component) continue

    const componentRadius = Math.max(118, (component.diameter / 2) + 72)
    let placedX = 0
    let placedY = 0

    if (index > 0) {
      let foundSpot = false
      for (let attempt = 0; attempt < 260; attempt += 1) {
        const angle = (index * goldenAngle) + (attempt * 0.5)
        const radius = 132 + (Math.sqrt(attempt + 1) * (88 + (componentRadius * 0.06)))
        const candidateX = Math.cos(angle) * radius
        const candidateY = Math.sin(angle) * radius * 0.84

        const overlaps = placedComponents.some((placedComponent) => {
          const dx = placedComponent.x - candidateX
          const dy = placedComponent.y - candidateY
          const minDistance = placedComponent.radius + componentRadius + 34
          return ((dx * dx) + (dy * dy)) < (minDistance * minDistance)
        })

        if (!overlaps) {
          placedX = candidateX
          placedY = candidateY
          foundSpot = true
          break
        }
      }

      if (!foundSpot) {
        const fallbackAngle = index * goldenAngle
        const fallbackRadius = 180 + (index * 76)
        placedX = Math.cos(fallbackAngle) * fallbackRadius
        placedY = Math.sin(fallbackAngle) * fallbackRadius * 0.82
      }
    }

    placedX *= fieldCompression
    placedY *= fieldCompression

    placedComponents.push({
      nodes: component.nodes,
      diameter: component.diameter,
      x: placedX,
      y: placedY,
      radius: componentRadius
    })

    for (const node of component.nodes) {
      mergedNodes.push({
        ...node,
        x: node.x + placedX,
        y: node.y + placedY
      })
    }
  }

  return mergedNodes
}

function computeLayoutBounds(nodes: readonly ArtistGraphLayoutNode[]) {
  if (nodes.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
  }

  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const node of nodes) {
    minX = Math.min(minX, node.x)
    maxX = Math.max(maxX, node.x)
    minY = Math.min(minY, node.y)
    maxY = Math.max(maxY, node.y)
  }

  return { minX, maxX, minY, maxY }
}

function relaxArtistGraphLayout(
  nodes: readonly ArtistGraphLayoutNode[],
  edges: readonly ArtistGraphEdge[],
  options: RelaxLayoutOptions = {}
): ArtistGraphLayoutNode[] {
  if (nodes.length <= 1) {
    return nodes.slice()
  }

  const fixedNodeKeys = options.fixedNodeKeys ?? new Set<string>()
  const positions = nodes.map((node) => ({
    ...node,
    x: node.x,
    y: node.y
  }))
  const nodeIndexByKey = new Map(positions.map((node, index) => [node.key, index]))
  const maxIterations = nodes.length > 180 ? 18 : nodes.length > 90 ? 24 : 32
  const repulsionStrength = nodes.length > 180 ? 9000 : 14000
  const baseLinkDistance = nodes.length > 180 ? 150 : 170

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const cooling = 1 - (iteration / maxIterations)
    const maxStep = 18 * cooling
    const deltaX = new Array<number>(positions.length).fill(0)
    const deltaY = new Array<number>(positions.length).fill(0)

    for (let leftIndex = 0; leftIndex < positions.length; leftIndex += 1) {
      const left = positions[leftIndex]
      if (!left) continue

      for (let rightIndex = leftIndex + 1; rightIndex < positions.length; rightIndex += 1) {
        const right = positions[rightIndex]
        if (!right) continue

        let dx = right.x - left.x
        let dy = right.y - left.y
        let distanceSquared = (dx * dx) + (dy * dy)
        if (distanceSquared < 0.01) {
          dx = 0.1 + (leftIndex * 0.01)
          dy = 0.1 + (rightIndex * 0.01)
          distanceSquared = (dx * dx) + (dy * dy)
        }

        const distance = Math.sqrt(distanceSquared)
        const force = repulsionStrength / distanceSquared
        const forceX = (dx / distance) * force
        const forceY = (dy / distance) * force

        deltaX[leftIndex] -= forceX
        deltaY[leftIndex] -= forceY
        deltaX[rightIndex] += forceX
        deltaY[rightIndex] += forceY
      }
    }

    for (const edge of edges) {
      const sourceIndex = nodeIndexByKey.get(edge.source)
      const targetIndex = nodeIndexByKey.get(edge.target)
      if (sourceIndex == null || targetIndex == null) continue

      const source = positions[sourceIndex]
      const target = positions[targetIndex]
      if (!source || !target) continue

      let dx = target.x - source.x
      let dy = target.y - source.y
      let distance = Math.sqrt((dx * dx) + (dy * dy))
      if (distance < 0.01) {
        dx = 0.1
        dy = 0.1
        distance = Math.sqrt((dx * dx) + (dy * dy))
      }

      const targetDistance = Math.max(90, baseLinkDistance - (Math.log2(edge.sharedTrackCount + 1) * 18))
      const springStrength = 0.02 + (Math.min(edge.sharedTrackCount, 6) * 0.008)
      const stretch = distance - targetDistance
      const forceX = (dx / distance) * stretch * springStrength
      const forceY = (dy / distance) * stretch * springStrength

      deltaX[sourceIndex] += forceX
      deltaY[sourceIndex] += forceY
      deltaX[targetIndex] -= forceX
      deltaY[targetIndex] -= forceY
    }

    for (let index = 0; index < positions.length; index += 1) {
      const node = positions[index]
      if (!node) continue

      deltaX[index] += -node.x * 0.0026
      deltaY[index] += -node.y * 0.0026

      if (fixedNodeKeys.has(node.key)) {
        node.x *= 0.7
        node.y *= 0.7
        continue
      }

      node.x += clamp(deltaX[index], -maxStep, maxStep)
      node.y += clamp(deltaY[index], -maxStep, maxStep)
    }
  }

  return positions
}

export function buildArtistGraphLayout(
  visibleGraph: ArtistGraphVisibleResult,
  options: Pick<ArtistGraphVisibleOptions, 'mode'>
): ArtistGraphLayoutResult {
  const cachedLayouts = artistGraphLayoutCache.get(visibleGraph)
  const cached = cachedLayouts?.get(options.mode)
  if (cached) {
    return cached
  }

  const cacheResult = (layout: ArtistGraphLayoutResult): ArtistGraphLayoutResult => {
    const nextCache = cachedLayouts ?? new Map<string, ArtistGraphLayoutResult>()
    nextCache.set(options.mode, layout)
    if (!cachedLayouts) {
      artistGraphLayoutCache.set(visibleGraph, nextCache)
    }
    return layout
  }

  if (visibleGraph.nodes.length === 0) {
    return cacheResult({
      nodes: [],
      edges: [],
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 }
    })
  }

  const graphIndex = indexArtistGraph({
    nodes: visibleGraph.nodes,
    edges: visibleGraph.edges,
    maxTrackCount: visibleGraph.nodes.reduce((maxTrackCount, node) => Math.max(maxTrackCount, node.trackCount), 0),
    maxEdgeWeight: visibleGraph.edges.reduce((maxEdgeWeight, edge) => Math.max(maxEdgeWeight, edge.sharedTrackCount), 0)
  })

  if (options.mode === 'focus') {
    return cacheResult(buildFocusLayout(visibleGraph, graphIndex))
  }

  const components = buildConnectedComponents(visibleGraph)
    .sort((left, right) => right.length - left.length)

  let revealOrderSeed = 0
  const laidOutComponents = components.map((componentArtistKeys) => {
    const layout = buildComponentLayout(componentArtistKeys, graphIndex, revealOrderSeed)
    revealOrderSeed += layout.nodes.length
    return layout
  })

  const mergedNodes = placeComponentsOnField(laidOutComponents)

  const relaxedNodes = relaxArtistGraphLayout(mergedNodes, visibleGraph.edges)
  const nodeRevealOrderByKey = new Map(relaxedNodes.map((node) => [node.key, node.revealOrder]))
  const layoutEdges = visibleGraph.edges.map<ArtistGraphLayoutEdge>((edge) => ({
    key: edge.key,
    revealOrder: Math.max(
      nodeRevealOrderByKey.get(edge.source) ?? 0,
      nodeRevealOrderByKey.get(edge.target) ?? 0
    )
  }))

  return cacheResult({
    nodes: relaxedNodes,
    edges: layoutEdges,
    bounds: computeLayoutBounds(relaxedNodes)
  })
}
