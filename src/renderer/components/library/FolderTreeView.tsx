import { memo, ReactElement, useCallback, useMemo, useRef, useState } from 'react'
import { List, RowComponentProps } from 'react-window'
import { type DbTrack, type LibraryFolder } from '../../stores/libraryStore'
import { usePlayerStore } from '../../stores/playerStore'
import type { Track } from '../../types/audio'

interface FolderTreeViewProps {
  tracks: DbTrack[]
  folders: LibraryFolder[]
  searchQuery: string
}

interface FolderTreeNode {
  name: string
  fullPath: string
  children: Map<string, FolderTreeNode>
  tracks: DbTrack[]
  totalTrackCount: number
}

// A visible row is either a folder or a track
interface FolderRow {
  type: 'folder'
  node: FolderTreeNode
  guideMask: boolean[]
  isLast: boolean
  isRoot: boolean
}

interface TrackRow {
  type: 'track'
  track: DbTrack
  folderTracks: DbTrack[] // all tracks in the immediate parent folder (for queue)
  guideMask: boolean[]
  isLast: boolean
}

type VisibleRow = FolderRow | TrackRow

const FOLDER_ROW_HEIGHT = 32
const FOLDER_ROOT_ROW_HEIGHT = 42
const TRACK_ROW_HEIGHT = 28

function dbTrackToTrack(dbTrack: DbTrack): Track {
  return {
    id: dbTrack.path,
    path: dbTrack.path,
    title: dbTrack.title,
    artist: dbTrack.artist,
    album: dbTrack.album,
    albumArtist: dbTrack.album_artist ?? undefined,
    duration: dbTrack.duration,
    format: dbTrack.format,
    artworkHash: dbTrack.artwork_hash ?? undefined,
    sampleRate: dbTrack.sample_rate ?? undefined,
    bitDepth: dbTrack.bit_depth ?? undefined,
    bitrate: dbTrack.bitrate ?? undefined,
    channels: dbTrack.channels ?? undefined,
    replayGainTrackDb: dbTrack.replaygain_track_gain_db ?? undefined,
    replayGainAlbumDb: dbTrack.replaygain_album_gain_db ?? undefined,
    sourceType: dbTrack.source_type,
    sourceId: dbTrack.source_id ?? undefined,
    sourceTrackId: dbTrack.source_track_id ?? undefined,
    sourcePath: dbTrack.source_path ?? undefined,
    isAvailable: dbTrack.is_available === 1,
    availabilityReason: dbTrack.availability_reason ?? undefined
  }
}

function formatDuration(seconds: number): string {
  if (!seconds || !isFinite(seconds)) return '--:--'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function computeTotalTrackCount(node: FolderTreeNode): number {
  let count = node.tracks.length
  for (const child of node.children.values()) {
    count += computeTotalTrackCount(child)
  }
  node.totalTrackCount = count
  return count
}

interface RowSharedProps {
  rows: VisibleRow[]
  currentTrackPath: string | null
  onPlayTrack: (track: DbTrack, folderTracks: DbTrack[]) => void
  onToggleExpand: (fullPath: string) => void
  expandedNodes: Set<string>
}

function FolderTreeRowRenderer({
  ariaAttributes,
  index,
  style,
  rows,
  currentTrackPath,
  onPlayTrack,
  onToggleExpand,
  expandedNodes,
}: RowComponentProps<RowSharedProps>): ReactElement | null {
  const row = rows[index]
  if (!row) return null

  if (row.type === 'folder') {
    const { node, guideMask, isLast, isRoot } = row
    const isExpanded = expandedNodes.has(node.fullPath)

    return (
      <div {...ariaAttributes} style={style}>
        <div
          className={`folder-browse-node ${isRoot ? 'is-root' : ''}`}
          onClick={() => onToggleExpand(node.fullPath)}
        >
          {!isRoot && (
            <span className="folder-tree-guide">
              {guideMask.map((hasLine, i) => (
                <span key={i} className={`folder-tree-guide-col ${hasLine ? 'has-line' : ''}`} />
              ))}
              <span className={`folder-tree-guide-branch ${isLast ? 'is-last' : ''}`} />
            </span>
          )}
          <button className={`folder-tree-chevron ${isExpanded ? 'is-expanded' : ''}`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
          {isRoot && (
            <svg className="folder-tree-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
            </svg>
          )}
          <span className="folder-browse-name" title={node.fullPath}>{node.name}</span>
          <span className="folder-browse-count">{node.totalTrackCount}</span>
        </div>
      </div>
    )
  }

  // Track row
  const { track, folderTracks, guideMask, isLast } = row
  const isActive = track.path === currentTrackPath

  return (
    <div {...ariaAttributes} style={style}>
      <div
        className={`folder-browse-track ${isActive ? 'is-active' : ''}`}
        onClick={() => onPlayTrack(track, folderTracks)}
      >
        <span className="folder-tree-guide">
          {guideMask.map((hasLine, j) => (
            <span key={j} className={`folder-tree-guide-col ${hasLine ? 'has-line' : ''}`} />
          ))}
          <span className={`folder-tree-guide-branch ${isLast ? 'is-last' : ''}`} />
        </span>
        <button
          className="folder-browse-track-play"
          onClick={(e) => { e.stopPropagation(); onPlayTrack(track, folderTracks) }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
        <span className="folder-browse-track-title" title={track.title}>{track.title}</span>
        <span className="folder-browse-track-artist">{track.artist}</span>
        <span className="folder-browse-track-duration">{formatDuration(track.duration)}</span>
      </div>
    </div>
  )
}

const MemoizedRow = memo(FolderTreeRowRenderer) as typeof FolderTreeRowRenderer

export default function FolderTreeView({ tracks, folders, searchQuery }: FolderTreeViewProps) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const { setQueue, loadTrack, play, currentTrack } = usePlayerStore()
  const listBodyRef = useRef<HTMLDivElement>(null)

  const normalizedQuery = searchQuery.trim().toLowerCase()

  const filteredTracks = useMemo(() => {
    if (!normalizedQuery) return tracks
    return tracks.filter((t) =>
      t.title.toLowerCase().includes(normalizedQuery)
      || t.artist.toLowerCase().includes(normalizedQuery)
      || t.album.toLowerCase().includes(normalizedQuery)
      || t.path.toLowerCase().includes(normalizedQuery)
    )
  }, [tracks, normalizedQuery])

  const tree = useMemo(() => {
    const roots: FolderTreeNode[] = folders.map((f) => ({
      name: f.path.split('/').pop() || f.path,
      fullPath: f.path,
      children: new Map(),
      tracks: [],
      totalTrackCount: 0
    }))

    // Sort roots by path length descending so longest paths are checked first (handles nested roots)
    const sortedRoots = [...roots].sort((a, b) => b.fullPath.length - a.fullPath.length)

    for (const track of filteredTracks) {
      const root = sortedRoots.find((r) => track.path.startsWith(r.fullPath + '/') || track.path.startsWith(r.fullPath + '\\'))
      if (!root) continue

      const relative = track.path.slice(root.fullPath.length + 1)
      const segments = relative.split(/[/\\]/)
      segments.pop() // remove filename

      let current = root
      let pathSoFar = root.fullPath
      for (const segment of segments) {
        pathSoFar += '/' + segment
        if (!current.children.has(segment)) {
          current.children.set(segment, {
            name: segment,
            fullPath: pathSoFar,
            children: new Map(),
            tracks: [],
            totalTrackCount: 0
          })
        }
        current = current.children.get(segment)!
      }
      current.tracks.push(track)
    }

    roots.forEach(computeTotalTrackCount)

    // Prune empty roots
    return roots.filter((r) => r.totalTrackCount > 0)
  }, [filteredTracks, folders])

  // Flatten the tree into visible rows based on expanded state
  const visibleRows = useMemo(() => {
    const rows: VisibleRow[] = []

    function flattenNode(node: FolderTreeNode, guideMask: boolean[], isLast: boolean, isRoot: boolean) {
      rows.push({ type: 'folder', node, guideMask, isLast, isRoot })

      if (!expandedNodes.has(node.fullPath)) return

      const childMask = isRoot ? [] : [...guideMask, !isLast]
      const sortedChildren = [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))
      const sortedTracks = [...node.tracks].sort((a, b) => a.path.localeCompare(b.path))
      const totalItems = sortedChildren.length + sortedTracks.length

      sortedChildren.forEach(([, child], i) => {
        const childIsLast = i === sortedChildren.length - 1 && sortedTracks.length === 0
        flattenNode(child, childMask, childIsLast, false)
      })

      sortedTracks.forEach((track, i) => {
        const isLastItem = sortedChildren.length + i === totalItems - 1
        rows.push({ type: 'track', track, folderTracks: sortedTracks, guideMask: childMask, isLast: isLastItem })
      })
    }

    tree.forEach((root, i) => {
      flattenNode(root, [], i === tree.length - 1, true)
    })

    return rows
  }, [tree, expandedNodes])

  // Compute row heights (root folder nodes are taller)
  const rowHeight = useCallback((index: number): number => {
    const row = visibleRows[index]
    if (!row) return TRACK_ROW_HEIGHT
    if (row.type === 'folder' && row.isRoot) return FOLDER_ROOT_ROW_HEIGHT
    if (row.type === 'folder') return FOLDER_ROW_HEIGHT
    return TRACK_ROW_HEIGHT
  }, [visibleRows])

  const toggleExpand = useCallback((fullPath: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(fullPath)) {
        next.delete(fullPath)
      } else {
        next.add(fullPath)
      }
      return next
    })
  }, [])

  const handlePlayTrack = useCallback(async (track: DbTrack, folderTracks: DbTrack[]) => {
    const queueTracks = folderTracks.map(dbTrackToTrack)
    const index = folderTracks.findIndex((t) => t.path === track.path)
    setQueue(queueTracks, index >= 0 ? index : 0)

    const result = await window.electronAPI.loadAudioFile(track.path, { metadataMode: 'none' })
    if (!result) return

    const playTrack: Track = {
      ...dbTrackToTrack(track),
      artworkData: result.metadata?.artwork,
      channels: result.metadata?.channels ?? track.channels ?? undefined,
      codec: result.metadata?.codec ?? undefined,
      codecProfile: result.metadata?.codecProfile ?? undefined,
      isAtmosJoc: result.metadata?.isAtmosJoc ?? false,
    }

    const loaded = await loadTrack(playTrack, result.data)
    if (loaded) {
      await play()
    }
  }, [loadTrack, play, setQueue])

  const currentTrackPath = currentTrack?.path ?? null

  const rowProps: RowSharedProps = useMemo(() => ({
    rows: visibleRows,
    currentTrackPath,
    onPlayTrack: handlePlayTrack,
    onToggleExpand: toggleExpand,
    expandedNodes,
  }), [visibleRows, currentTrackPath, handlePlayTrack, toggleExpand, expandedNodes])

  if (tree.length === 0) {
    return (
      <div className="library-empty">
        {normalizedQuery
          ? <p>No tracks found for &ldquo;{searchQuery.trim()}&rdquo;</p>
          : <p>No folders with tracks</p>
        }
      </div>
    )
  }

  return (
    <div className="folder-browse-tree" ref={listBodyRef}>
      <List
        className="folder-browse-virtualized"
        defaultHeight={TRACK_ROW_HEIGHT * 8}
        overscanCount={10}
        rowComponent={MemoizedRow}
        rowCount={visibleRows.length}
        rowHeight={rowHeight}
        rowProps={rowProps}
        style={{ height: '100%', width: '100%' }}
      />
    </div>
  )
}
