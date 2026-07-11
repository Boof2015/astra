import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from 'react'
import { useLibraryStore } from '../../stores/libraryStore'
import { useGraphStore } from '../../stores/graphStore'
import { useUIStore } from '../../stores/uiStore'
import { useThemeStore } from '../../stores/themeStore'
import {
  buildArtistGraph,
  buildArtistGraphLayout,
  indexArtistGraph,
  resolveVisibleArtistGraph,
  type ArtistGraphBuildResult,
  type ArtistGraphNode
} from '../../utils/libraryGraph'
import { getFuzzyFieldScore } from '../../utils/fuzzySearch'

interface GraphViewport {
  panX: number
  panY: number
  zoom: number
}

interface GraphDragState {
  pointerId: number
  startClientX: number
  startClientY: number
  startPanX: number
  startPanY: number
}

interface SimulationNode {
  key: string
  x: number
  y: number
  vx: number
  vy: number
  revealOrder: number
  active: boolean
}

const MIN_ZOOM = 0.12
const MAX_ZOOM = 2.2
const DEFAULT_VIEWPORT: GraphViewport = {
  panX: 0,
  panY: 0,
  zoom: 1
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function getSimulationRenderIntervalMs(nodeCount: number, edgeCount: number): number {
  if (edgeCount <= 90 && nodeCount <= 56) {
    return 0
  }
  if (edgeCount <= 150 && nodeCount <= 84) {
    return 1000 / 55
  }
  if (edgeCount <= 240 && nodeCount <= 120) {
    return 1000 / 48
  }
  if (edgeCount <= 360 && nodeCount <= 170) {
    return 1000 / 36
  }
  if (edgeCount > 600 || nodeCount > 220) {
    return 1000 / 18
  }
  if (edgeCount > 360 || nodeCount > 150) {
    return 1000 / 22
  }
  return 1000 / 28
}

function hashStringToUnit(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash * 31) + value.charCodeAt(index)) >>> 0
  }
  return hash / 0xffffffff
}

function computeBoundsFromPoints(points: readonly { x: number; y: number }[]) {
  if (points.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
  }

  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const point of points) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }

  return { minX, maxX, minY, maxY }
}

function buildFitViewport(
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  width: number,
  height: number
): GraphViewport {
  if (width <= 0 || height <= 0) {
    return DEFAULT_VIEWPORT
  }

  const graphWidth = Math.max(260, bounds.maxX - bounds.minX)
  const graphHeight = Math.max(260, bounds.maxY - bounds.minY)
  const paddingX = Math.min(104, width * 0.075)
  const paddingY = Math.min(84, height * 0.075)
  const zoom = clamp(
    Math.min((width - (paddingX * 2)) / graphWidth, (height - (paddingY * 2)) / graphHeight, 1.08),
    MIN_ZOOM,
    MAX_ZOOM
  )
  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerY = (bounds.minY + bounds.maxY) / 2

  return {
    zoom,
    panX: -(centerX * zoom),
    panY: -(centerY * zoom)
  }
}

function buildCenteredViewport(pointX: number, pointY: number, zoom: number): GraphViewport {
  return {
    zoom,
    panX: -(pointX * zoom),
    panY: -(pointY * zoom)
  }
}

function findBestArtistMatch(
  graph: ArtistGraphBuildResult,
  query: string
): ArtistGraphNode | null {
  const trimmedQuery = query.trim()
  if (!trimmedQuery) return null

  const normalizedQuery = trimmedQuery.toLocaleLowerCase()
  const exact = graph.nodes.find((node) => node.artist.toLocaleLowerCase() === normalizedQuery)
  if (exact) return exact

  const scored = graph.nodes.map((node, index) => {
    const score = getFuzzyFieldScore(trimmedQuery, [
      { value: node.artist, weight: 1.5 }
    ])
    if (score === null) return null
    return { node, score, index }
  }).filter((result): result is { node: ArtistGraphNode; score: number; index: number } => result !== null)

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    return a.index - b.index
  })

  return scored[0]?.node ?? null
}

function getNodeRadius(node: ArtistGraphNode, maxTrackCount: number): number {
  if (maxTrackCount <= 0) return 12
  const normalized = Math.pow(node.trackCount / maxTrackCount, 0.58)
  return 10 + (normalized * 14)
}

function getNodeAnimationProgress(revealProgress: number, revealOrder: number, totalNodes: number): number {
  if (totalNodes <= 1) return 1
  const delay = (revealOrder / Math.max(1, totalNodes - 1)) * 0.78
  return clamp((revealProgress - delay) / 0.16, 0, 1)
}

function getEdgeAnimationProgress(revealProgress: number, revealOrder: number, totalEdges: number): number {
  if (totalEdges <= 1) return 1
  const delay = (revealOrder / Math.max(1, totalEdges - 1)) * 0.82
  return clamp((revealProgress - delay) / 0.14, 0, 1)
}

const settingsIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

const closeIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
)

export default function GraphView() {
  const trackPaths = useLibraryStore((state) => state.trackPaths)
  const fullTrackPaths = useLibraryStore((state) => state.fullTrackPaths)
  const fullTracksStatus = useLibraryStore((state) => state.fullTracksStatus)
  const trackCacheVersion = useLibraryStore((state) => state.trackCacheVersion)
  const resolveTrackPaths = useLibraryStore((state) => state.resolveTrackPaths)
  const totalTrackCount = useLibraryStore((state) => state.totalTrackCount)
  const isLibraryLoading = useLibraryStore((state) => state.isLoading)
  const selectedAlbum = useLibraryStore((state) => state.selectedAlbum)
  const selectedArtist = useLibraryStore((state) => state.selectedArtist)
  const loadFullTracks = useLibraryStore((state) => state.loadFullTracks)
  const releaseFullTracks = useLibraryStore((state) => state.releaseFullTracks)
  const selectArtist = useLibraryStore((state) => state.selectArtist)

  const mode = useGraphStore((state) => state.mode)
  const focusedArtistKey = useGraphStore((state) => state.focusedArtistKey)
  const selectedArtistKey = useGraphStore((state) => state.selectedArtistKey)
  const edgeWeightThreshold = useGraphStore((state) => state.edgeWeightThreshold)
  const focusNeighborLimit = useGraphStore((state) => state.focusNeighborLimit)
  const setSelectedArtistKey = useGraphStore((state) => state.setSelectedArtistKey)
  const setEdgeWeightThreshold = useGraphStore((state) => state.setEdgeWeightThreshold)
  const openFullMap = useGraphStore((state) => state.openFullMap)
  const openFocusedGraph = useGraphStore((state) => state.openFocusedGraph)
  const expandFocusNeighbors = useGraphStore((state) => state.expandFocusNeighbors)
  const resetFocusNeighbors = useGraphStore((state) => state.resetFocusNeighbors)

  const setActiveView = useUIStore((state) => state.setActiveView)
  const isLightTheme = useThemeStore((state) => state.resolvedTokens.isLight)
  const graphEdgeStroke = isLightTheme
    ? 'rgba(30, 41, 59, 0.82)'
    : 'rgba(255, 255, 255, 0.88)'
  const graphNodeFills = isLightTheme
    ? {
      selected: 'rgba(15, 23, 42, 0.86)',
      hovered: 'rgba(30, 41, 59, 0.74)',
      focusRoot: 'rgba(51, 65, 85, 0.62)',
      compared: 'rgba(71, 85, 105, 0.64)',
      base: 'rgba(100, 116, 139, 0.52)',
    }
    : {
      selected: 'rgba(240, 244, 252, 0.95)',
      hovered: 'rgba(226, 231, 240, 0.88)',
      focusRoot: 'rgba(196, 204, 218, 0.76)',
      compared: 'rgba(188, 198, 216, 0.8)',
      base: 'rgba(174, 182, 196, 0.7)',
    }

  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const surfaceObserverRef = useRef<ResizeObserver | null>(null)
  const dragStateRef = useRef<GraphDragState | null>(null)
  const dragMovedRef = useRef(false)
  const viewportFrameRef = useRef<number | null>(null)
  const simulationFrameRef = useRef<number | null>(null)
  const viewportRef = useRef<GraphViewport>(DEFAULT_VIEWPORT)
  const simulationNodesRef = useRef<SimulationNode[]>([])

  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 })
  const [viewport, setViewport] = useState<GraphViewport>(DEFAULT_VIEWPORT)
  const [revealProgress, setRevealProgress] = useState(0)
  const [searchInput, setSearchInput] = useState('')
  const [searchFeedback, setSearchFeedback] = useState('')
  const [hoveredArtistKey, setHoveredArtistKey] = useState<string | null>(null)
  const [comparisonArtistKey, setComparisonArtistKey] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [simulationNodes, setSimulationNodes] = useState<SimulationNode[]>([])

  useEffect(() => {
    viewportRef.current = viewport
  }, [viewport])

  const tracks = useMemo(
    () => resolveTrackPaths(trackPaths),
    [resolveTrackPaths, trackCacheVersion, trackPaths]
  )
  // Wait for the full list before building the graph: partial reveals during
  // progressive library loading would recompute the simulation per page.
  const fullTracks = useMemo(
    () => (fullTracksStatus === 'complete' ? resolveTrackPaths(fullTrackPaths) : []),
    [resolveTrackPaths, fullTrackPaths, fullTracksStatus, trackCacheVersion]
  )
  const graphTracks = fullTracks.length > 0
    ? fullTracks
    : (!selectedAlbum && !selectedArtist ? tracks : [])

  useEffect(() => {
    if (totalTrackCount <= 0 || graphTracks.length > 0 || isLibraryLoading) return
    if (fullTracksStatus === 'loading') return
    void loadFullTracks('graph')
  }, [fullTracksStatus, graphTracks.length, isLibraryLoading, loadFullTracks, totalTrackCount])

  const setSurfaceRef = useCallback((node: HTMLDivElement | null) => {
    surfaceObserverRef.current?.disconnect()
    surfaceObserverRef.current = null
    surfaceRef.current = node
    if (!node) {
      setSurfaceSize({ width: 0, height: 0 })
      return
    }
    const measure = () => {
      const rect = node.getBoundingClientRect()
      setSurfaceSize({ width: rect.width, height: rect.height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    surfaceObserverRef.current = observer
  }, [])

  useEffect(() => () => {
    surfaceObserverRef.current?.disconnect()
    surfaceObserverRef.current = null
  }, [])

  const graph = useMemo(
    () => buildArtistGraph(graphTracks),
    [graphTracks]
  )
  const graphIndex = useMemo(
    () => indexArtistGraph(graph),
    [graph]
  )
  const visibleGraph = useMemo(() => resolveVisibleArtistGraph(graph, {
    mode,
    focusArtistKey: focusedArtistKey,
    edgeWeightThreshold,
    focusNeighborLimit
  }), [edgeWeightThreshold, focusNeighborLimit, focusedArtistKey, graph, mode])
  const seedLayout = useMemo(
    () => buildArtistGraphLayout(visibleGraph, { mode }),
    [mode, visibleGraph]
  )
  const seedNodeByKey = useMemo(
    () => new Map(seedLayout.nodes.map((node) => [node.key, node])),
    [seedLayout.nodes]
  )
  const layoutEdgeByKey = useMemo(
    () => new Map(seedLayout.edges.map((edge) => [edge.key, edge])),
    [seedLayout.edges]
  )
  const visibleEdgesByArtistKey = useMemo(() => {
    const edgeBuckets = new Map<string, typeof visibleGraph.edges>()

    for (const edge of visibleGraph.edges) {
      const sourceBucket = edgeBuckets.get(edge.source)
      if (sourceBucket) {
        sourceBucket.push(edge)
      } else {
        edgeBuckets.set(edge.source, [edge])
      }

      const targetBucket = edgeBuckets.get(edge.target)
      if (targetBucket) {
        targetBucket.push(edge)
      } else {
        edgeBuckets.set(edge.target, [edge])
      }
    }

    return edgeBuckets
  }, [visibleGraph.edges])

  const cancelViewportAnimation = useCallback(() => {
    if (viewportFrameRef.current != null) {
      window.cancelAnimationFrame(viewportFrameRef.current)
      viewportFrameRef.current = null
    }
  }, [])

  const animateViewportTo = useCallback((targetViewport: GraphViewport, durationMs: number = 260) => {
    cancelViewportAnimation()

    const startViewport = viewportRef.current
    const startedAt = performance.now()

    const step = (now: number) => {
      const progress = clamp((now - startedAt) / durationMs, 0, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      const nextViewport = {
        panX: startViewport.panX + ((targetViewport.panX - startViewport.panX) * eased),
        panY: startViewport.panY + ((targetViewport.panY - startViewport.panY) * eased),
        zoom: startViewport.zoom + ((targetViewport.zoom - startViewport.zoom) * eased)
      }
      setViewport(nextViewport)
      if (progress < 1) {
        viewportFrameRef.current = window.requestAnimationFrame(step)
      } else {
        viewportFrameRef.current = null
      }
    }

    viewportFrameRef.current = window.requestAnimationFrame(step)
  }, [cancelViewportAnimation])

  useEffect(() => {
    if (simulationFrameRef.current != null) {
      window.cancelAnimationFrame(simulationFrameRef.current)
      simulationFrameRef.current = null
    }

    if (seedLayout.nodes.length === 0) {
      simulationNodesRef.current = []
      setSimulationNodes([])
      setRevealProgress(0)
      return
    }

    const orderedSeedNodes = seedLayout.nodes
      .slice()
      .sort((left, right) => left.revealOrder - right.revealOrder)
      .map<SimulationNode>((node) => {
        const jitterAngle = hashStringToUnit(node.key) * Math.PI * 2
        const jitterRadius = 14 + (hashStringToUnit(`${node.key}:r`) * 26)
        return {
          key: node.key,
          x: node.x + (Math.cos(jitterAngle) * jitterRadius),
          y: node.y + (Math.sin(jitterAngle) * jitterRadius),
          vx: 0,
          vy: 0,
          revealOrder: node.revealOrder,
          active: false
        }
      })
    const nodeIndexByKey = new Map(orderedSeedNodes.map((node, index) => [node.key, index]))
    const graphDensity = visibleGraph.nodes.length > 1
      ? visibleGraph.edges.length / visibleGraph.nodes.length
      : 0
    const forceScale = 1 / (1 + Math.max(0, graphDensity - 1.1) * 0.22)
    const velocityScale = Math.max(0.52, forceScale)
    const renderIntervalMs = getSimulationRenderIntervalMs(visibleGraph.nodes.length, visibleGraph.edges.length)
    const durationMs = mode === 'focus'
      ? Math.min(5400, Math.max(1800, 900 + (orderedSeedNodes.length * 88)))
      : Math.min(12000, Math.max(2600, 1300 + (orderedSeedNodes.length * 92)))
    const startedAt = performance.now()
    let lastActiveCount = 0
    let lastRenderedAt = 0
    let lastRenderedActiveCount = 0
    let lastRenderedProgress = 0

    simulationNodesRef.current = orderedSeedNodes
    setSimulationNodes(orderedSeedNodes.map((node) => ({ ...node })))
    setRevealProgress(0)

    const commitSimulationFrame = (
      nodes: SimulationNode[],
      progress: number,
      activeCount: number,
      now: number,
      force: boolean = false
    ) => {
      const shouldCommit = force ||
        activeCount !== lastRenderedActiveCount ||
        progress === 1 && lastRenderedProgress < 1 ||
        (progress - lastRenderedProgress) >= 0.05 ||
        (now - lastRenderedAt) >= renderIntervalMs

      if (!shouldCommit) {
        return
      }

      lastRenderedAt = now
      lastRenderedActiveCount = activeCount
      lastRenderedProgress = progress
      setRevealProgress(progress)
      setSimulationNodes(nodes.map((node) => ({ ...node })))
    }

    const tick = (now: number) => {
      const progress = clamp((now - startedAt) / durationMs, 0, 1)
      const nodes = simulationNodesRef.current
      const activeCount = progress <= 0
        ? 0
        : Math.min(nodes.length, Math.max(1, Math.ceil(Math.pow(progress, 0.94) * nodes.length)))

      if (activeCount > lastActiveCount) {
        for (let index = lastActiveCount; index < activeCount; index += 1) {
          const node = nodes[index]
          if (!node) continue
          node.active = true

          const randomAngle = hashStringToUnit(`${node.key}:spawn`) * Math.PI * 2
          const randomSpeed = (2.2 + (hashStringToUnit(`${node.key}:speed`) * 2.2)) * Math.max(0.64, velocityScale)
          node.vx += Math.cos(randomAngle) * randomSpeed
          node.vy += Math.sin(randomAngle) * randomSpeed

          for (const edge of visibleEdgesByArtistKey.get(node.key) ?? []) {
            const otherKey = edge.source === node.key ? edge.target : edge.source
            const otherIndex = nodeIndexByKey.get(otherKey)
            if (otherIndex == null || otherIndex >= activeCount) continue

            const otherNode = nodes[otherIndex]
            if (!otherNode || !otherNode.active) continue

            const dx = node.x - otherNode.x
            const dy = node.y - otherNode.y
            const distance = Math.max(1, Math.sqrt((dx * dx) + (dy * dy)))
            const impulse = (0.26 + (Math.min(edge.sharedTrackCount, 5) * 0.06)) * Math.max(0.62, forceScale)

            otherNode.vx -= (dx / distance) * impulse
            otherNode.vy -= (dy / distance) * impulse
          }
        }
        lastActiveCount = activeCount
      }

      const alpha = Math.max(0.014, ((1 - progress) * 0.16 + 0.022) * Math.max(0.58, forceScale))
      const repulsionStrength = (mode === 'focus' ? 18000 : 26000) * Math.max(0.5, forceScale)
      const centerForce = mode === 'focus' ? 0.0022 : 0.00105
      const damping = progress < 1
        ? 0.88 + (Math.min(0.04, graphDensity * 0.004))
        : 0.942 + (Math.min(0.026, graphDensity * 0.003))
      const anchorStrength = graphDensity > 1.8
        ? (mode === 'focus' ? 0.0014 : 0.00095) * (1 + Math.min(1.1, (graphDensity - 1.8) * 0.16))
        : 0
      const maxVelocity = (progress < 1 ? 3.8 : 1.9) * Math.max(0.68, velocityScale)

      for (let leftIndex = 0; leftIndex < activeCount; leftIndex += 1) {
        const leftNode = nodes[leftIndex]
        if (!leftNode || !leftNode.active) continue

        const localEdgeCount = visibleEdgesByArtistKey.get(leftNode.key)?.length ?? 0
        const centerMultiplier = graphDensity > 1.25
          ? localEdgeCount <= 1
            ? 2.6
            : localEdgeCount <= 2
              ? 1.95
              : 1.14
          : 1
        let forceX = -leftNode.x * centerForce * centerMultiplier
        let forceY = -leftNode.y * centerForce * centerMultiplier

        for (let rightIndex = leftIndex + 1; rightIndex < activeCount; rightIndex += 1) {
          const rightNode = nodes[rightIndex]
          if (!rightNode || !rightNode.active) continue

          let dx = rightNode.x - leftNode.x
          let dy = rightNode.y - leftNode.y
          let distanceSquared = (dx * dx) + (dy * dy)

          if (distanceSquared < 0.01) {
            dx = 0.1 + (leftIndex * 0.01)
            dy = 0.1 + (rightIndex * 0.01)
            distanceSquared = (dx * dx) + (dy * dy)
          }

          const distance = Math.sqrt(distanceSquared)
          const repulsion = repulsionStrength / distanceSquared
          const repulsionX = (dx / distance) * repulsion
          const repulsionY = (dy / distance) * repulsion

          forceX -= repulsionX
          forceY -= repulsionY
          rightNode.vx += repulsionX * alpha
          rightNode.vy += repulsionY * alpha
        }

        leftNode.vx += forceX * alpha
        leftNode.vy += forceY * alpha
      }

      for (const edge of visibleGraph.edges) {
        const sourceIndex = nodeIndexByKey.get(edge.source)
        const targetIndex = nodeIndexByKey.get(edge.target)
        if (sourceIndex == null || targetIndex == null || sourceIndex >= activeCount || targetIndex >= activeCount) {
          continue
        }

        const sourceNode = nodes[sourceIndex]
        const targetNode = nodes[targetIndex]
        if (!sourceNode || !targetNode || !sourceNode.active || !targetNode.active) continue

        let dx = targetNode.x - sourceNode.x
        let dy = targetNode.y - sourceNode.y
        let distance = Math.sqrt((dx * dx) + (dy * dy))
        if (distance < 0.01) {
          dx = 0.1
          dy = 0.1
          distance = Math.sqrt((dx * dx) + (dy * dy))
        }

        const targetDistance = mode === 'focus'
          ? Math.max(84, 176 - (Math.log2(edge.sharedTrackCount + 1) * 20))
          : Math.max(78, 148 - (Math.log2(edge.sharedTrackCount + 1) * 14))
        const springStrength = mode === 'focus'
          ? (0.0105 + (Math.min(edge.sharedTrackCount, 6) * 0.0022)) * Math.max(0.58, forceScale)
          : (0.0095 + (Math.min(edge.sharedTrackCount, 6) * 0.0019)) * Math.max(0.6, forceScale)
        const stretch = distance - targetDistance
        const springX = (dx / distance) * stretch * springStrength
        const springY = (dy / distance) * stretch * springStrength

        sourceNode.vx += springX
        sourceNode.vy += springY
        targetNode.vx -= springX
        targetNode.vy -= springY
      }

      for (let index = 0; index < activeCount; index += 1) {
        const node = nodes[index]
        if (!node || !node.active) continue

        if (anchorStrength > 0) {
          const seedNode = seedNodeByKey.get(node.key)
          if (seedNode) {
            node.vx += (seedNode.x - node.x) * anchorStrength
            node.vy += (seedNode.y - node.y) * anchorStrength
          }
        }

        if (mode === 'focus' && visibleGraph.focusArtistKey && node.key === visibleGraph.focusArtistKey) {
          node.vx += -node.x * 0.035
          node.vy += -node.y * 0.035
        } else if (progress >= 1) {
          const driftAngle = hashStringToUnit(`${node.key}:${Math.floor(now / 1400)}`) * Math.PI * 2
          node.vx += Math.cos(driftAngle) * (0.0034 * Math.max(0.58, forceScale))
          node.vy += Math.sin(driftAngle) * (0.0034 * Math.max(0.58, forceScale))
        }

        const speed = Math.sqrt((node.vx * node.vx) + (node.vy * node.vy))
        if (speed > maxVelocity) {
          const clampRatio = maxVelocity / speed
          node.vx *= clampRatio
          node.vy *= clampRatio
        }

        node.vx *= damping
        node.vy *= damping
        node.x += node.vx
        node.y += node.vy
      }

      commitSimulationFrame(nodes, progress, activeCount, now)

      simulationFrameRef.current = window.requestAnimationFrame(tick)
    }

    simulationFrameRef.current = window.requestAnimationFrame(tick)

    return () => {
      if (simulationFrameRef.current != null) {
        window.cancelAnimationFrame(simulationFrameRef.current)
        simulationFrameRef.current = null
      }
    }
  }, [mode, seedLayout.nodes, visibleEdgesByArtistKey, visibleGraph.edges, visibleGraph.focusArtistKey])

  useEffect(() => {
    cancelViewportAnimation()
    const points = simulationNodes.length > 0
      ? simulationNodes.map((node) => ({ x: node.x, y: node.y }))
      : seedLayout.nodes
    setViewport(buildFitViewport(computeBoundsFromPoints(points), surfaceSize.width, surfaceSize.height))
  }, [cancelViewportAnimation, seedLayout.nodes, simulationNodes.length, surfaceSize.height, surfaceSize.width])

  useEffect(() => {
    if (!searchFeedback) return
    const timeoutId = window.setTimeout(() => {
      setSearchFeedback('')
    }, 2200)
    return () => window.clearTimeout(timeoutId)
  }, [searchFeedback])

  useEffect(() => {
    document.body.style.userSelect = isPanning ? 'none' : ''
    document.body.style.webkitUserSelect = isPanning ? 'none' : ''

    return () => {
      document.body.style.userSelect = ''
      document.body.style.webkitUserSelect = ''
    }
  }, [isPanning])

  useEffect(() => {
    return () => {
      if (simulationFrameRef.current != null) {
        window.cancelAnimationFrame(simulationFrameRef.current)
        simulationFrameRef.current = null
      }
      if (viewportFrameRef.current != null) {
        window.cancelAnimationFrame(viewportFrameRef.current)
        viewportFrameRef.current = null
      }
      dragStateRef.current = null
      simulationNodesRef.current = []
      viewportRef.current = DEFAULT_VIEWPORT
      releaseFullTracks('graph')
    }
  }, [releaseFullTracks])

  const simulationNodeByKey = useMemo(
    () => new Map(simulationNodes.map((node) => [node.key, node])),
    [simulationNodes]
  )
  const activeSimulationNodes = useMemo(
    () => simulationNodes.filter((node) => node.active),
    [simulationNodes]
  )
  const revealedNodeKeys = useMemo(
    () => new Set(activeSimulationNodes.map((node) => node.key)),
    [activeSimulationNodes]
  )
  const renderedEdges = useMemo(
    () => visibleGraph.edges.filter((edge) => revealedNodeKeys.has(edge.source) && revealedNodeKeys.has(edge.target)),
    [revealedNodeKeys, visibleGraph.edges]
  )
  const renderedBounds = useMemo(
    () => computeBoundsFromPoints(activeSimulationNodes.map((node) => ({ x: node.x, y: node.y }))),
    [activeSimulationNodes]
  )

  const selectedNode = selectedArtistKey && revealedNodeKeys.has(selectedArtistKey)
    ? graphIndex.nodeByKey.get(selectedArtistKey) ?? null
    : null
  const focusNode = visibleGraph.focusArtistKey
    ? graphIndex.nodeByKey.get(visibleGraph.focusArtistKey) ?? null
    : null
  const lowZoomClusterDescriptors = useMemo(() => {
    if (visibleGraph.nodes.length === 0) {
      return []
    }

    const adjacency = new Map<string, Set<string>>()
    const unseen = new Set<string>()

    for (const node of visibleGraph.nodes) {
      adjacency.set(node.key, new Set())
      unseen.add(node.key)
    }

    for (const edge of visibleGraph.edges) {
      adjacency.get(edge.source)?.add(edge.target)
      adjacency.get(edge.target)?.add(edge.source)
    }

    const descriptors: Array<{
      key: string
      artist: string
      memberKeys: string[]
      score: number
    }> = []

    while (unseen.size > 0) {
      const iterator = unseen.values().next()
      const rootKey = iterator.value
      if (!rootKey) break

      const memberKeys: string[] = []
      const queue = [rootKey]
      unseen.delete(rootKey)
      let totalTrackCount = 0
      let labelNode: ArtistGraphNode | null = null

      while (queue.length > 0) {
        const currentKey = queue.shift()
        if (!currentKey) continue

        memberKeys.push(currentKey)

        const currentNode = graphIndex.nodeByKey.get(currentKey) ?? null
        if (currentNode) {
          totalTrackCount += currentNode.trackCount
          if (
            !labelNode ||
            currentNode.trackCount > labelNode.trackCount ||
            (
              currentNode.trackCount === labelNode.trackCount &&
              currentNode.collaboratorCount > labelNode.collaboratorCount
            ) ||
            (
              currentNode.trackCount === labelNode.trackCount &&
              currentNode.collaboratorCount === labelNode.collaboratorCount &&
              currentNode.artist.localeCompare(labelNode.artist, undefined, { sensitivity: 'base' }) < 0
            )
          ) {
            labelNode = currentNode
          }
        }

        for (const neighborKey of adjacency.get(currentKey) ?? []) {
          if (!unseen.has(neighborKey)) continue
          unseen.delete(neighborKey)
          queue.push(neighborKey)
        }
      }

      if (!labelNode) continue

      descriptors.push({
        key: labelNode.key,
        artist: labelNode.artist,
        memberKeys,
        score: totalTrackCount + (memberKeys.length * 6)
      })
    }

    descriptors.sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score
      }
      if (left.memberKeys.length !== right.memberKeys.length) {
        return right.memberKeys.length - left.memberKeys.length
      }
      return left.artist.localeCompare(right.artist, undefined, { sensitivity: 'base' })
    })

    const majorDescriptors = descriptors.filter((descriptor) => (
      descriptor.memberKeys.length >= 4 || descriptor.score >= 24
    ))

    return (majorDescriptors.length > 0 ? majorDescriptors : descriptors.slice(0, Math.min(4, descriptors.length))).slice(0, 8)
  }, [graphIndex.nodeByKey, visibleGraph.edges, visibleGraph.nodes])
  const lowZoomClusterLabels = useMemo(() => {
    if (viewport.zoom > 0.58) {
      return []
    }

    const labels: Array<{
      key: string
      artist: string
      left: number
      top: number
      opacity: number
    }> = []

    for (const descriptor of lowZoomClusterDescriptors) {
      if (!revealedNodeKeys.has(descriptor.key)) {
        continue
      }

      const memberNodes = descriptor.memberKeys
        .map((memberKey) => simulationNodeByKey.get(memberKey))
        .filter((node): node is SimulationNode => node != null && node.active)

      if (memberNodes.length === 0) continue

      let minX = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY
      let maxY = Number.NEGATIVE_INFINITY

      for (const memberNode of memberNodes) {
        minX = Math.min(minX, memberNode.x)
        maxX = Math.max(maxX, memberNode.x)
        maxY = Math.max(maxY, memberNode.y)
      }

      const left = (surfaceSize.width / 2) + viewport.panX + (((minX + maxX) / 2) * viewport.zoom)
      const top = (surfaceSize.height / 2) + viewport.panY + (maxY * viewport.zoom) + 10

      if (labels.some((label) => Math.abs(label.left - left) < 120 && Math.abs(label.top - top) < 24)) {
        continue
      }

      labels.push({
        key: descriptor.key,
        artist: descriptor.artist,
        left,
        top,
        opacity: descriptor.memberKeys.length >= 8 ? 0.38 : descriptor.memberKeys.length >= 5 ? 0.32 : 0.27
      })
    }

    return labels
  }, [lowZoomClusterDescriptors, revealedNodeKeys, simulationNodeByKey, surfaceSize.height, surfaceSize.width, viewport.panX, viewport.panY, viewport.zoom])

  useEffect(() => {
    if (!selectedArtistKey) return
    if (revealedNodeKeys.has(selectedArtistKey)) return
    setSelectedArtistKey(null)
  }, [revealedNodeKeys, selectedArtistKey, setSelectedArtistKey])

  const selectedNeighbors = useMemo(
    () => selectedArtistKey
      ? (graphIndex.neighborsByArtistKey.get(selectedArtistKey) ?? []).filter((neighbor) => revealedNodeKeys.has(neighbor.artistKey))
      : [],
    [graphIndex.neighborsByArtistKey, revealedNodeKeys, selectedArtistKey]
  )
  const visibleSelectedNeighborCount = selectedNeighbors.length

  useEffect(() => {
    if (!comparisonArtistKey) return
    if (selectedNeighbors.some((neighbor) => neighbor.artistKey === comparisonArtistKey)) return
    setComparisonArtistKey(null)
  }, [comparisonArtistKey, selectedNeighbors])

  const selectedComparison = comparisonArtistKey
    ? selectedNeighbors.find((neighbor) => neighbor.artistKey === comparisonArtistKey) ?? null
    : null
  const selectedComparisonEdge = selectedComparison
    ? graphIndex.edgeByKey.get(selectedComparison.edgeKey) ?? null
    : null

  const activeHighlightArtistKey = hoveredArtistKey ?? selectedArtistKey ?? null
  const highlightedArtistKeys = useMemo(() => {
    if (!activeHighlightArtistKey) return new Set<string>()

    const highlighted = new Set<string>([activeHighlightArtistKey])
    for (const neighbor of graphIndex.neighborsByArtistKey.get(activeHighlightArtistKey) ?? []) {
      if (revealedNodeKeys.has(neighbor.artistKey)) {
        highlighted.add(neighbor.artistKey)
      }
    }
    return highlighted
  }, [activeHighlightArtistKey, graphIndex.neighborsByArtistKey, revealedNodeKeys])
  const shouldBatchSettledEdges = revealProgress >= 1 && renderedEdges.length > 180 && !activeHighlightArtistKey && !selectedComparisonEdge
  const batchedSettledEdgePaths = useMemo(() => {
    if (!shouldBatchSettledEdges) {
      return null
    }

    const thinSegments: string[] = []
    const mediumSegments: string[] = []
    const thickSegments: string[] = []

    for (const edge of renderedEdges) {
      const sourceNode = simulationNodeByKey.get(edge.source)
      const targetNode = simulationNodeByKey.get(edge.target)
      if (!sourceNode || !targetNode) continue

      const segment = `M${sourceNode.x.toFixed(1)} ${sourceNode.y.toFixed(1)}L${targetNode.x.toFixed(1)} ${targetNode.y.toFixed(1)}`
      const edgeWeightRatio = edge.sharedTrackCount / Math.max(1, graph.maxEdgeWeight)

      if (edgeWeightRatio >= 0.45) {
        thickSegments.push(segment)
      } else if (edgeWeightRatio >= 0.18) {
        mediumSegments.push(segment)
      } else {
        thinSegments.push(segment)
      }
    }

    return {
      thin: thinSegments.join(''),
      medium: mediumSegments.join(''),
      thick: thickSegments.join('')
    }
  }, [graph.maxEdgeWeight, renderedEdges, shouldBatchSettledEdges, simulationNodeByKey])

  const handleArtistSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const match = findBestArtistMatch(graph, searchInput)
    if (!match) {
      setSearchFeedback('No artist match found.')
      return
    }

    setSearchInput(match.artist)
    setSelectedArtistKey(match.key)
    setComparisonArtistKey(null)

    if (!revealedNodeKeys.has(match.key) || mode === 'focus') {
      openFocusedGraph(match.artist)
      return
    }

    const simulationNode = simulationNodeByKey.get(match.key)
    if (simulationNode) {
      animateViewportTo(buildCenteredViewport(simulationNode.x, simulationNode.y, Math.max(viewportRef.current.zoom, 0.82)))
    }
  }

  const handleOpenArtistInLibrary = useCallback(async (artistName: string) => {
    await selectArtist(artistName, 'library')
    setActiveView('library')
  }, [selectArtist, setActiveView])

  const handleRecenter = () => {
    const centeredArtistKey = selectedArtistKey ?? visibleGraph.focusArtistKey
    if (centeredArtistKey) {
      const simulationNode = simulationNodeByKey.get(centeredArtistKey)
      if (simulationNode) {
        animateViewportTo(buildCenteredViewport(simulationNode.x, simulationNode.y, Math.max(viewportRef.current.zoom, 0.82)))
        return
      }
    }

    animateViewportTo(buildFitViewport(renderedBounds, surfaceSize.width, surfaceSize.height))
  }

  const handleSurfacePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    cancelViewportAnimation()

    dragMovedRef.current = false
    setIsPanning(true)
    dragStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: viewportRef.current.panX,
      startPanY: viewportRef.current.panY
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleSurfacePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) return

    const deltaX = event.clientX - dragState.startClientX
    const deltaY = event.clientY - dragState.startClientY
    if ((deltaX * deltaX) + (deltaY * deltaY) > 9) {
      dragMovedRef.current = true
    }

    setViewport({
      ...viewportRef.current,
      panX: dragState.startPanX + deltaX,
      panY: dragState.startPanY + deltaY
    })
  }

  const handleSurfacePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId !== event.pointerId) return
    setIsPanning(false)
    dragStateRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleSurfaceWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    const surface = surfaceRef.current
    if (!surface) return

    cancelViewportAnimation()

    const rect = surface.getBoundingClientRect()
    const currentViewport = viewportRef.current
    const pointerX = event.clientX - rect.left
    const pointerY = event.clientY - rect.top
    const centerX = rect.width / 2
    const centerY = rect.height / 2
    const zoomFactor = Math.exp(-event.deltaY * 0.0009)
    const nextZoom = clamp(
      currentViewport.zoom * zoomFactor,
      MIN_ZOOM,
      MAX_ZOOM
    )
    const graphX = (pointerX - centerX - currentViewport.panX) / currentViewport.zoom
    const graphY = (pointerY - centerY - currentViewport.panY) / currentViewport.zoom

    setViewport({
      zoom: nextZoom,
      panX: pointerX - centerX - (graphX * nextZoom),
      panY: pointerY - centerY - (graphY * nextZoom)
    })
  }

  const handleSurfaceClick = () => {
    if (dragMovedRef.current) {
      dragMovedRef.current = false
      return
    }

    setSelectedArtistKey(null)
    setComparisonArtistKey(null)
  }

  const revealedArtistCountLabel = `${revealedNodeKeys.size}/${graph.nodes.length}`
  const revealedEdgeCountLabel = `${renderedEdges.length}/${graph.edges.length}`

  if (totalTrackCount > 0 && graphTracks.length === 0) {
    return (
      <div className="graph-view">
        <div className="graph-loading">
          <div className="loading-spinner" />
          <p>Preparing the library graph...</p>
        </div>
      </div>
    )
  }

  if (graphTracks.length === 0) {
    return (
      <div className="graph-view">
        <div className="graph-empty-state">
          <div className="empty-icon">&#9783;</div>
          <p>Your library needs tracks before the graph can draw anything.</p>
          <p className="empty-hint">Scan folders in Settings &gt; Library to start building relationships.</p>
        </div>
      </div>
    )
  }

  if (graph.edges.length === 0) {
    return (
      <div className="graph-view">
        <div className="graph-empty-state">
          <div className="empty-icon">&#9673;</div>
          <p>No shared artist credits were found in the current metadata.</p>
          <p className="empty-hint">The graph appears when tracks contain multi-artist credits such as features or collaborations.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="graph-view">
      <div className="graph-canvas-frame">
        <div
          ref={setSurfaceRef}
          className={`graph-surface${isPanning ? ' is-panning' : ''}`}
          onClick={handleSurfaceClick}
          onPointerDown={handleSurfacePointerDown}
          onPointerMove={handleSurfacePointerMove}
          onPointerUp={handleSurfacePointerUp}
          onPointerCancel={handleSurfacePointerUp}
          onWheel={handleSurfaceWheel}
        >
          <div
            className="graph-overlay-top"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="graph-overlay-brand">
              <span className={`graph-mode-pill ${mode === 'focus' ? 'is-local' : 'is-global'}`}>
                {mode === 'focus' ? 'Local Graph' : 'Global Graph'}
              </span>
              {focusNode && (
                <span className="graph-status-pill graph-status-pill-soft">
                  Focused on {focusNode.artist}
                </span>
              )}
            </div>

            <div className="graph-overlay-actions">
              <button
                type="button"
                className={`graph-icon-btn ${showSettings ? 'active' : ''}`}
                onClick={() => {
                  setShowSettings((value) => {
                    const nextValue = !value
                    if (nextValue) {
                      setComparisonArtistKey(null)
                    }
                    return nextValue
                  })
                }}
                aria-label="Toggle graph settings"
              >
                {settingsIcon}
              </button>
            </div>
          </div>

          {!selectedNode && revealProgress >= 1 && (
            <div
              className="graph-overlay-hint"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              Drag to pan, scroll to zoom, hover to trace connections, click a node to inspect it.
            </div>
          )}

          {lowZoomClusterLabels.map((label) => (
            <div
              key={label.key}
              className="graph-cluster-label"
              style={{
                left: `${label.left}px`,
                top: `${label.top}px`,
                opacity: label.opacity
              }}
            >
              {label.artist}
            </div>
          ))}

          <div
            className="graph-overlay-bottom"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <span className="graph-status-pill">Artists {revealedArtistCountLabel}</span>
            <span className="graph-status-pill">Edges {revealedEdgeCountLabel}</span>
            {mode === 'focus' && (
              <span className="graph-status-pill">Local graph breadth {focusNeighborLimit}</span>
            )}
            {visibleGraph.effectiveEdgeThreshold !== edgeWeightThreshold && (
              <span className="graph-status-pill graph-status-pill-accent">
                Showing weaker links because the current filter hid everything.
              </span>
            )}
            {searchFeedback && (
              <span className="graph-status-pill graph-status-pill-warning">{searchFeedback}</span>
            )}
          </div>

          {showSettings && (
            <aside
              className="graph-settings-panel"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="graph-flyout-head">
                <div>
                  <div className="graph-panel-eyebrow">Settings</div>
                  <h3>{mode === 'focus' ? 'Local Graph' : 'Global Graph'}</h3>
                </div>
                <button
                  type="button"
                  className="graph-icon-btn"
                  onClick={() => setShowSettings(false)}
                  aria-label="Close graph settings"
                >
                  {closeIcon}
                </button>
              </div>

              <form className="graph-search graph-search-panel" onSubmit={handleArtistSearchSubmit}>
                <input
                  className="graph-search-input"
                  type="text"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="Find artist..."
                  spellCheck={false}
                />
                <button type="submit" className="settings-btn settings-btn-primary">Find</button>
              </form>

              <div className="graph-settings-grid">
                <label className="graph-toolbar-select">
                  <span>Edge Strength</span>
                  <select
                    className="settings-select"
                    value={edgeWeightThreshold}
                    onChange={(event) => setEdgeWeightThreshold(Number(event.target.value))}
                  >
                    <option value={1}>1+ shared tracks</option>
                    <option value={2}>2+ shared tracks</option>
                    <option value={3}>3+ shared tracks</option>
                    <option value={4}>4+ shared tracks</option>
                  </select>
                </label>

                <div className="graph-settings-actions">
                  <button type="button" className="settings-btn" onClick={handleRecenter}>
                    Re-center View
                  </button>
                  {mode === 'focus' ? (
                    <>
                      <button
                        type="button"
                        className="settings-btn"
                        onClick={() => {
                          resetFocusNeighbors()
                          openFullMap()
                        }}
                      >
                        Show Full Graph
                      </button>
                      {visibleGraph.hiddenFocusNeighborCount > 0 && (
                        <button type="button" className="settings-btn" onClick={() => expandFocusNeighbors()}>
                          Show More ({visibleGraph.hiddenFocusNeighborCount})
                        </button>
                      )}
                    </>
                  ) : (
                    selectedNode && (
                      <button
                        type="button"
                        className="settings-btn"
                        onClick={() => openFocusedGraph(selectedNode.artist)}
                      >
                        Open Local Graph
                      </button>
                    )
                  )}
                </div>
              </div>

              <p className="graph-settings-note">
                The global graph stays neutral until you interact with it. The local graph is only used when you explicitly focus one artist.
              </p>
            </aside>
          )}

          {activeSimulationNodes.length === 0 ? (
            <div
              className="graph-surface-empty"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <p>Building the graph…</p>
            </div>
          ) : (
            <svg className="graph-svg" role="img" aria-label="Artist relationship graph">
              <g
                transform={`translate(${(surfaceSize.width / 2) + viewport.panX} ${(surfaceSize.height / 2) + viewport.panY}) scale(${viewport.zoom})`}
              >
                {shouldBatchSettledEdges && batchedSettledEdgePaths ? (
                  <>
                    {batchedSettledEdgePaths.thin && (
                      <path
                        d={batchedSettledEdgePaths.thin}
                        fill="none"
                        stroke={graphEdgeStroke}
                        strokeOpacity={0.08}
                        strokeWidth={0.6}
                        strokeLinecap="round"
                      />
                    )}
                    {batchedSettledEdgePaths.medium && (
                      <path
                        d={batchedSettledEdgePaths.medium}
                        fill="none"
                        stroke={graphEdgeStroke}
                        strokeOpacity={0.12}
                        strokeWidth={1}
                        strokeLinecap="round"
                      />
                    )}
                    {batchedSettledEdgePaths.thick && (
                      <path
                        d={batchedSettledEdgePaths.thick}
                        fill="none"
                        stroke={graphEdgeStroke}
                        strokeOpacity={0.18}
                        strokeWidth={1.6}
                        strokeLinecap="round"
                      />
                    )}
                  </>
                ) : renderedEdges.map((edge) => {
                  const sourceNode = simulationNodeByKey.get(edge.source)
                  const targetNode = simulationNodeByKey.get(edge.target)
                  const layoutEdge = layoutEdgeByKey.get(edge.key)
                  if (!sourceNode || !targetNode || !layoutEdge) return null

                  const dx = targetNode.x - sourceNode.x
                  const dy = targetNode.y - sourceNode.y
                  const length = Math.sqrt((dx * dx) + (dy * dy))
                  const animationProgress = getEdgeAnimationProgress(revealProgress, layoutEdge.revealOrder, seedLayout.edges.length)
                  const isComparisonEdge = selectedComparisonEdge?.key === edge.key
                  const isHighlightedEdge = activeHighlightArtistKey
                    ? edge.source === activeHighlightArtistKey || edge.target === activeHighlightArtistKey
                    : false
                  const edgeWeightRatio = edge.sharedTrackCount / Math.max(1, graph.maxEdgeWeight)
                  const strokeOpacity = activeHighlightArtistKey
                    ? isComparisonEdge
                      ? 0.92 * animationProgress
                      : isHighlightedEdge
                        ? (0.42 + (edgeWeightRatio * 0.2)) * animationProgress
                        : 0.04 * animationProgress
                    : (0.1 + (edgeWeightRatio * 0.18)) * animationProgress
                  const strokeWidth = isComparisonEdge
                    ? 2.6
                    : isHighlightedEdge
                      ? 0.9 + (edgeWeightRatio * 1.4)
                      : 0.55 + (edgeWeightRatio * 0.8)

                  return (
                    <line
                      key={edge.key}
                      x1={sourceNode.x}
                      y1={sourceNode.y}
                      x2={targetNode.x}
                      y2={targetNode.y}
                      stroke={graphEdgeStroke}
                      strokeOpacity={strokeOpacity}
                      strokeWidth={strokeWidth}
                      strokeLinecap="round"
                      strokeDasharray={`${length} ${length}`}
                      strokeDashoffset={length * (1 - animationProgress)}
                    />
                  )
                })}

                {activeSimulationNodes.map((simulationNode) => {
                  const node = graphIndex.nodeByKey.get(simulationNode.key)
                  if (!node) return null

                  const animationProgress = getNodeAnimationProgress(revealProgress, simulationNode.revealOrder, seedLayout.nodes.length)
                  const radius = getNodeRadius(node, graph.maxTrackCount)
                  const isSelected = selectedNode?.key === node.key
                  const isHovered = hoveredArtistKey === node.key
                  const isFocusRoot = visibleGraph.focusArtistKey === node.key
                  const isCompared = comparisonArtistKey === node.key
                  const isHighlighted = highlightedArtistKeys.size === 0 || highlightedArtistKeys.has(node.key)
                  const isDimmed = highlightedArtistKeys.size > 0 && !isHighlighted
                  const showLabel = viewport.zoom >= 0.72 || isSelected || isHovered || isFocusRoot
                  const opacity = isDimmed ? 0.2 : 1

                  return (
                    <g
                      key={simulationNode.key}
                      className="graph-node"
                      transform={`translate(${simulationNode.x} ${simulationNode.y}) scale(${0.82 + (animationProgress * 0.18)})`}
                      opacity={animationProgress}
                      onPointerDown={(event) => event.stopPropagation()}
                      onPointerEnter={(event) => {
                        event.stopPropagation()
                        setHoveredArtistKey(node.key)
                      }}
                      onPointerLeave={(event) => {
                        event.stopPropagation()
                        setHoveredArtistKey((current) => current === node.key ? null : current)
                      }}
                      onDoubleClick={(event) => {
                        event.stopPropagation()
                        void handleOpenArtistInLibrary(node.artist)
                      }}
                      onClick={(event) => {
                        event.stopPropagation()
                        setSelectedArtistKey(node.key)
                        setComparisonArtistKey(null)
                        setShowSettings(false)
                      }}
                    >
                      <circle
                        r={radius}
                        fill={
                          isSelected
                            ? graphNodeFills.selected
                            : isHovered
                              ? graphNodeFills.hovered
                              : isFocusRoot
                                ? graphNodeFills.focusRoot
                                : isCompared
                                  ? graphNodeFills.compared
                                  : graphNodeFills.base
                        }
                        opacity={opacity}
                      />
                      {showLabel && (
                        <text
                          className={`graph-node-label ${isDimmed ? 'is-dimmed' : ''}`}
                          x={radius + 7}
                          y={4}
                        >
                          {node.artist}
                        </text>
                      )}
                    </g>
                  )
                })}
              </g>
            </svg>
          )}

          {selectedNode && !showSettings && (
            <aside
              className="graph-inspector-panel"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="graph-flyout-head">
                <div>
                  <div className="graph-panel-eyebrow">Artist</div>
                  <h3>{selectedNode.artist}</h3>
                </div>
                <button
                  type="button"
                  className="graph-icon-btn"
                  onClick={() => {
                    setSelectedArtistKey(null)
                    setComparisonArtistKey(null)
                  }}
                  aria-label="Close artist inspector"
                >
                  {closeIcon}
                </button>
              </div>

              <div className="graph-inspector-stats">
                <div className="graph-inspector-stat">
                  <strong>{selectedNode.trackCount}</strong>
                  <span>Tracks</span>
                </div>
                <div className="graph-inspector-stat">
                  <strong>{visibleSelectedNeighborCount}</strong>
                  <span>Visible links</span>
                </div>
              </div>

              <div className="graph-panel-actions">
                <button
                  type="button"
                  className="settings-btn settings-btn-primary"
                  onClick={() => void handleOpenArtistInLibrary(selectedNode.artist)}
                >
                  Open In Library
                </button>
                {(mode === 'full' || visibleGraph.focusArtistKey !== selectedNode.key) && (
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={() => openFocusedGraph(selectedNode.artist)}
                  >
                    Local Graph
                  </button>
                )}
              </div>

              <section className="graph-panel-section">
                <div className="graph-panel-section-title">Visible Connections</div>
                {selectedNeighbors.length > 0 ? (
                  <div className="graph-collaborator-list">
                    {selectedNeighbors.slice(0, 10).map((neighbor) => (
                      <button
                        key={neighbor.artistKey}
                        type="button"
                        className={`graph-collaborator-row ${comparisonArtistKey === neighbor.artistKey ? 'active' : ''}`}
                        onClick={() => {
                          setComparisonArtistKey(neighbor.artistKey)
                          const simulationNode = simulationNodeByKey.get(neighbor.artistKey)
                          if (simulationNode) {
                            animateViewportTo(
                              buildCenteredViewport(simulationNode.x, simulationNode.y, Math.max(viewportRef.current.zoom, 0.82)),
                              220
                            )
                          }
                        }}
                      >
                        <span>{neighbor.artist}</span>
                        <span>{neighbor.sharedTrackCount}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="graph-panel-empty">No visible connections for the current filter.</p>
                )}
              </section>

              {selectedComparison && selectedComparisonEdge ? (
                <section className="graph-panel-section">
                  <div className="graph-panel-section-title">
                    {selectedNode.artist} ↔ {selectedComparison.artist}
                  </div>

                  <div className="graph-panel-shared-stats">
                    <div className="graph-panel-stat-card">
                      <strong>{selectedComparison.sharedTrackCount}</strong>
                      <span>Shared tracks</span>
                    </div>
                    <div className="graph-panel-stat-card">
                      <strong>{selectedComparison.sharedReleaseCount}</strong>
                      <span>Shared releases</span>
                    </div>
                  </div>

                  <div className="graph-panel-subsection">
                    <div className="graph-panel-subtitle">Track Evidence</div>
                    <div className="graph-panel-item-list">
                      {selectedComparisonEdge.sampleTracks.map((track) => (
                        <div key={track.path} className="graph-panel-item">
                          <strong>{track.title}</strong>
                          <span>{track.album}{track.year ? ` · ${track.year}` : ''}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="graph-panel-subsection">
                    <div className="graph-panel-subtitle">Shared Releases</div>
                    <div className="graph-panel-item-list">
                      {selectedComparisonEdge.sampleReleases.map((release) => (
                        <div key={release.identityKey} className="graph-panel-item">
                          <strong>{release.album}</strong>
                          <span>{release.year ? String(release.year) : 'Year unknown'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
              ) : (
                <p className="graph-panel-empty">
                  Pick a connected artist to inspect the edge between them.
                </p>
              )}
            </aside>
          )}
        </div>
      </div>
    </div>
  )
}
