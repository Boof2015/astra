import { memo, ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { List, RowComponentProps } from 'react-window'
import { type DbTrack, type LibraryFolder } from '../../stores/libraryStore'
import { usePlayerStore } from '../../stores/playerStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import type { Track } from '../../types/audio'
import CreatePlaylistModal from '../playlists/CreatePlaylistModal'
import PlaylistCover from '../playlists/PlaylistCover'

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
  subtreeTracks: DbTrack[]
  totalTrackCount: number
}

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
  folderTracks: DbTrack[]
  guideMask: boolean[]
  isLast: boolean
}

type VisibleRow = FolderRow | TrackRow

interface FolderPlaylistPopupState {
  folderPath: string
  anchor: {
    top: number
    left: number
    right: number
    bottom: number
    height: number
  }
}

interface FolderPlaylistFeedback {
  kind: 'info' | 'error'
  message: string
}

interface FolderPlaylistCreateState {
  folderName: string
  trackPaths: string[]
}

interface RowSharedProps {
  rows: VisibleRow[]
  currentTrackPath: string | null
  onPlayTrack: (track: DbTrack, folderTracks: DbTrack[]) => void
  onShuffleFolder: (node: FolderTreeNode) => void
  onOpenPlaylistPopup: (event: React.MouseEvent<HTMLButtonElement>, node: FolderTreeNode) => void
  onToggleExpand: (fullPath: string) => void
  expandedNodes: Set<string>
  playlistPopupFolderPath: string | null
}

const FOLDER_ROW_HEIGHT = 32
const FOLDER_ROOT_ROW_HEIGHT = 42
const TRACK_ROW_HEIGHT = 28
const FOLDER_TREE_OVERSCAN_COUNT = 10

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

function getFolderName(fullPath: string): string {
  const parts = fullPath.split(/[/\\]/)
  return parts[parts.length - 1] || fullPath
}

function finalizeFolderNode(node: FolderTreeNode): number {
  node.tracks.sort((a, b) => a.path.localeCompare(b.path))

  let totalTrackCount = node.tracks.length
  const subtreeTracks: DbTrack[] = []
  const sortedChildren = [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))

  sortedChildren.forEach(([, child]) => {
    totalTrackCount += finalizeFolderNode(child)
    subtreeTracks.push(...child.subtreeTracks)
  })

  subtreeTracks.push(...node.tracks)
  node.subtreeTracks = subtreeTracks
  node.totalTrackCount = totalTrackCount
  return totalTrackCount
}

function FolderTreeRowRenderer({
  ariaAttributes,
  index,
  style,
  rows,
  currentTrackPath,
  onPlayTrack,
  onShuffleFolder,
  onOpenPlaylistPopup,
  onToggleExpand,
  expandedNodes,
  playlistPopupFolderPath
}: RowComponentProps<RowSharedProps>): ReactElement | null {
  const row = rows[index]
  if (!row) return null

  if (row.type === 'folder') {
    const { node, guideMask, isLast, isRoot } = row
    const isExpanded = expandedNodes.has(node.fullPath)
    const isPlaylistPopupOpen = playlistPopupFolderPath === node.fullPath

    return (
      <div {...ariaAttributes} style={style}>
        <div
          className={`folder-browse-node ${isRoot ? 'is-root' : ''}`}
          onClick={() => onToggleExpand(node.fullPath)}
        >
          {!isRoot && (
            <span className="folder-tree-guide">
              {guideMask.map((hasLine, guideIndex) => (
                <span key={guideIndex} className={`folder-tree-guide-col ${hasLine ? 'has-line' : ''}`} />
              ))}
              <span className={`folder-tree-guide-branch ${isLast ? 'is-last' : ''}`} />
            </span>
          )}
          <button type="button" className={`folder-tree-chevron ${isExpanded ? 'is-expanded' : ''}`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
          {isRoot && (
            <svg className="folder-tree-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
            </svg>
          )}
          <span className="folder-browse-main">
            <span className="folder-browse-name" title={node.fullPath}>{node.name}</span>
            <span className={`folder-browse-actions ${isPlaylistPopupOpen ? 'has-open-popover' : ''}`}>
              <button
                type="button"
                className="folder-browse-action-btn"
                title={`Shuffle ${node.name}`}
                aria-label={`Shuffle ${node.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  void onShuffleFolder(node)
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 3h5v5" />
                  <path d="M4 20 21 3" />
                  <path d="M21 16v5h-5" />
                  <path d="M15 15 21 21" />
                  <path d="M4 4 9 9" />
                </svg>
              </button>
              <button
                type="button"
                className={`folder-browse-action-btn ${isPlaylistPopupOpen ? 'active' : ''}`}
                title={`Add ${node.name} to playlist`}
                aria-label={`Add ${node.name} to playlist`}
                onClick={(event) => onOpenPlaylistPopup(event, node)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/>
                </svg>
              </button>
            </span>
          </span>
          <span className="folder-browse-count">{node.totalTrackCount}</span>
        </div>
      </div>
    )
  }

  const { track, folderTracks, guideMask, isLast } = row
  const isActive = track.path === currentTrackPath

  return (
    <div {...ariaAttributes} style={style}>
      <div
        className={`folder-browse-track ${isActive ? 'is-active' : ''}`}
        onClick={() => onPlayTrack(track, folderTracks)}
      >
        <span className="folder-tree-guide">
          {guideMask.map((hasLine, guideIndex) => (
            <span key={guideIndex} className={`folder-tree-guide-col ${hasLine ? 'has-line' : ''}`} />
          ))}
          <span className={`folder-tree-guide-branch ${isLast ? 'is-last' : ''}`} />
        </span>
        <button
          type="button"
          className="folder-browse-track-play"
          onClick={(event) => {
            event.stopPropagation()
            void onPlayTrack(track, folderTracks)
          }}
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
  const [folderPlaylistPopup, setFolderPlaylistPopup] = useState<FolderPlaylistPopupState | null>(null)
  const [folderPlaylistSearch, setFolderPlaylistSearch] = useState('')
  const [folderPlaylistFeedback, setFolderPlaylistFeedback] = useState<FolderPlaylistFeedback | null>(null)
  const [isFolderPlaylistMutating, setIsFolderPlaylistMutating] = useState(false)
  const [createPlaylistTarget, setCreatePlaylistTarget] = useState<FolderPlaylistCreateState | null>(null)

  const currentTrack = usePlayerStore((state) => state.currentTrack)
  const startPlaybackContext = usePlayerStore((state) => state.startPlaybackContext)
  const shuffle = usePlayerStore((state) => state.shuffle)
  const toggleShuffle = usePlayerStore((state) => state.toggleShuffle)
  const playlists = usePlaylistStore((state) => state.playlists)
  const addToPlaylist = usePlaylistStore((state) => state.addToPlaylist)
  const createPlaylist = usePlaylistStore((state) => state.createPlaylist)
  const setPlaylistCustomCoverFromFile = usePlaylistStore((state) => state.setPlaylistCustomCoverFromFile)
  const getPlaylistTrackPaths = usePlaylistStore((state) => state.getPlaylistTrackPaths)

  const folderPlaylistPopupRef = useRef<HTMLDivElement | null>(null)
  const folderPlaylistTriggerRef = useRef<HTMLButtonElement | null>(null)

  const normalizedQuery = searchQuery.trim().toLowerCase()

  const filteredTracks = useMemo(() => {
    if (!normalizedQuery) return tracks
    return tracks.filter((track) => (
      track.title.toLowerCase().includes(normalizedQuery)
      || track.artist.toLowerCase().includes(normalizedQuery)
      || track.album.toLowerCase().includes(normalizedQuery)
      || track.path.toLowerCase().includes(normalizedQuery)
    ))
  }, [tracks, normalizedQuery])

  const tree = useMemo(() => {
    const roots: FolderTreeNode[] = folders.map((folder) => ({
      name: getFolderName(folder.path),
      fullPath: folder.path,
      children: new Map(),
      tracks: [],
      subtreeTracks: [],
      totalTrackCount: 0
    }))

    const sortedRoots = [...roots].sort((a, b) => b.fullPath.length - a.fullPath.length)

    for (const track of filteredTracks) {
      const root = sortedRoots.find((candidate) => (
        track.path.startsWith(candidate.fullPath + '/')
        || track.path.startsWith(candidate.fullPath + '\\')
      ))
      if (!root) continue

      const relative = track.path.slice(root.fullPath.length + 1)
      const segments = relative.split(/[/\\]/)
      segments.pop()

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
            subtreeTracks: [],
            totalTrackCount: 0
          })
        }
        current = current.children.get(segment)!
      }

      current.tracks.push(track)
    }

    roots.forEach(finalizeFolderNode)
    return roots.filter((root) => root.totalTrackCount > 0)
  }, [filteredTracks, folders])

  const folderNodesByPath = useMemo(() => {
    const next = new Map<string, FolderTreeNode>()

    const visit = (node: FolderTreeNode) => {
      next.set(node.fullPath, node)
      for (const child of node.children.values()) {
        visit(child)
      }
    }

    tree.forEach(visit)
    return next
  }, [tree])

  const visibleRows = useMemo(() => {
    const rows: VisibleRow[] = []

    function flattenNode(node: FolderTreeNode, guideMask: boolean[], isLast: boolean, isRoot: boolean) {
      rows.push({ type: 'folder', node, guideMask, isLast, isRoot })

      if (!expandedNodes.has(node.fullPath)) return

      const childMask = isRoot ? [] : [...guideMask, !isLast]
      const sortedChildren = [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))
      const totalItems = sortedChildren.length + node.tracks.length

      sortedChildren.forEach(([, child], childIndex) => {
        const childIsLast = childIndex === sortedChildren.length - 1 && node.tracks.length === 0
        flattenNode(child, childMask, childIsLast, false)
      })

      node.tracks.forEach((track, trackIndex) => {
        const isLastItem = sortedChildren.length + trackIndex === totalItems - 1
        rows.push({
          type: 'track',
          track,
          folderTracks: node.tracks,
          guideMask: childMask,
          isLast: isLastItem
        })
      })
    }

    tree.forEach((root, rootIndex) => {
      flattenNode(root, [], rootIndex === tree.length - 1, true)
    })

    return rows
  }, [tree, expandedNodes])

  const currentFolderPlaylistNode = useMemo(() => {
    if (!folderPlaylistPopup) return null
    return folderNodesByPath.get(folderPlaylistPopup.folderPath) ?? null
  }, [folderNodesByPath, folderPlaylistPopup])

  const closeFolderPlaylistPopup = useCallback(() => {
    setFolderPlaylistPopup(null)
    setFolderPlaylistSearch('')
    setFolderPlaylistFeedback(null)
    setIsFolderPlaylistMutating(false)
    folderPlaylistTriggerRef.current = null
  }, [])

  const syncFolderPlaylistPopupAnchor = useCallback(() => {
    const trigger = folderPlaylistTriggerRef.current
    if (!trigger) {
      closeFolderPlaylistPopup()
      return
    }

    const rect = trigger.getBoundingClientRect()
    setFolderPlaylistPopup((current) => {
      if (!current) return current
      return {
        ...current,
        anchor: {
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          height: rect.height
        }
      }
    })
  }, [closeFolderPlaylistPopup])

  useEffect(() => {
    if (!folderPlaylistPopup) return
    if (folderNodesByPath.has(folderPlaylistPopup.folderPath)) return
    closeFolderPlaylistPopup()
  }, [closeFolderPlaylistPopup, folderNodesByPath, folderPlaylistPopup])

  useEffect(() => {
    if (!folderPlaylistPopup) return
    syncFolderPlaylistPopupAnchor()
  }, [folderPlaylistPopup, syncFolderPlaylistPopupAnchor, visibleRows])

  useEffect(() => {
    if (!folderPlaylistPopup) return

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (folderPlaylistPopupRef.current?.contains(target)) return
      if (folderPlaylistTriggerRef.current?.contains(target)) return
      closeFolderPlaylistPopup()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeFolderPlaylistPopup()
      }
    }

    const handleResize = () => {
      syncFolderPlaylistPopupAnchor()
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleResize)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleResize)
    }
  }, [closeFolderPlaylistPopup, folderPlaylistPopup, syncFolderPlaylistPopupAnchor])

  const rowHeight = useCallback((index: number): number => {
    const row = visibleRows[index]
    if (!row) return TRACK_ROW_HEIGHT
    if (row.type === 'folder' && row.isRoot) return FOLDER_ROOT_ROW_HEIGHT
    if (row.type === 'folder') return FOLDER_ROW_HEIGHT
    return TRACK_ROW_HEIGHT
  }, [visibleRows])

  const toggleExpand = useCallback((fullPath: string) => {
    closeFolderPlaylistPopup()
    setExpandedNodes((current) => {
      const next = new Set(current)
      if (next.has(fullPath)) {
        next.delete(fullPath)
      } else {
        next.add(fullPath)
      }
      return next
    })
  }, [closeFolderPlaylistPopup])

  const handlePlayTrack = useCallback(async (track: DbTrack, folderTracks: DbTrack[]) => {
    const queueTracks = folderTracks.map(dbTrackToTrack)
    const index = folderTracks.findIndex((candidate) => candidate.path === track.path)
    const queueIndex = index >= 0 ? index : 0
    await startPlaybackContext(queueTracks, queueIndex, {
      contextLabel: 'Folder'
    })
  }, [startPlaybackContext])

  const handleShuffleFolder = useCallback(async (node: FolderTreeNode) => {
    if (node.subtreeTracks.length === 0) return

    try {
      const queueTracks = node.subtreeTracks.map(dbTrackToTrack)
      const randomStartIndex = Math.floor(Math.random() * queueTracks.length)

      await startPlaybackContext(queueTracks, randomStartIndex, {
        contextLabel: node.name || node.fullPath
      })

      if (!shuffle) {
        toggleShuffle()
      }
    } catch (error) {
      console.error('Failed to shuffle folder playback:', error)
    }
  }, [shuffle, startPlaybackContext, toggleShuffle])

  const handleOpenPlaylistPopup = useCallback((event: React.MouseEvent<HTMLButtonElement>, node: FolderTreeNode) => {
    event.stopPropagation()

    if (folderPlaylistPopup?.folderPath === node.fullPath) {
      closeFolderPlaylistPopup()
      return
    }

    const trigger = event.currentTarget
    const rect = trigger.getBoundingClientRect()

    folderPlaylistTriggerRef.current = trigger
    setFolderPlaylistSearch('')
    setFolderPlaylistFeedback(null)
    setIsFolderPlaylistMutating(false)
    setFolderPlaylistPopup({
      folderPath: node.fullPath,
      anchor: {
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        height: rect.height
      }
    })
  }, [closeFolderPlaylistPopup, folderPlaylistPopup?.folderPath])

  const handleAddFolderToPlaylist = useCallback(async (playlistId: number) => {
    if (isFolderPlaylistMutating || !currentFolderPlaylistNode) return

    const folderTrackPaths = currentFolderPlaylistNode.subtreeTracks.map((track) => track.path)
    if (folderTrackPaths.length === 0) return

    setIsFolderPlaylistMutating(true)
    setFolderPlaylistFeedback(null)

    try {
      const existingTrackPaths = new Set(await getPlaylistTrackPaths(playlistId))
      const missingTrackPaths = folderTrackPaths.filter((trackPath) => !existingTrackPaths.has(trackPath))

      if (missingTrackPaths.length === 0) {
        setFolderPlaylistFeedback({
          kind: 'info',
          message: 'All visible tracks are already in this playlist.'
        })
        return
      }

      await addToPlaylist(playlistId, missingTrackPaths)
      closeFolderPlaylistPopup()
    } catch (error) {
      setFolderPlaylistFeedback({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Failed to add folder to playlist.'
      })
    } finally {
      setIsFolderPlaylistMutating(false)
    }
  }, [addToPlaylist, closeFolderPlaylistPopup, currentFolderPlaylistNode, getPlaylistTrackPaths, isFolderPlaylistMutating])

  const handleOpenCreatePlaylistModal = useCallback(() => {
    if (!currentFolderPlaylistNode) return

    setFolderPlaylistFeedback(null)
    setCreatePlaylistTarget({
      folderName: currentFolderPlaylistNode.name,
      trackPaths: currentFolderPlaylistNode.subtreeTracks.map((track) => track.path)
    })
  }, [currentFolderPlaylistNode])

  const handleCloseCreatePlaylistModal = useCallback(() => {
    setCreatePlaylistTarget(null)
  }, [])

  const handleCreatePlaylistFromFolder = useCallback(async (name: string, coverImagePath: string | null) => {
    if (!createPlaylistTarget) {
      throw new Error('No folder is selected for playlist creation.')
    }

    const playlist = await createPlaylist(name)
    if (coverImagePath && playlist.id > 0) {
      await setPlaylistCustomCoverFromFile(playlist.id, coverImagePath)
    }
    if (createPlaylistTarget.trackPaths.length > 0) {
      await addToPlaylist(playlist.id, createPlaylistTarget.trackPaths)
    }

    setCreatePlaylistTarget(null)
    closeFolderPlaylistPopup()
  }, [addToPlaylist, closeFolderPlaylistPopup, createPlaylist, createPlaylistTarget, setPlaylistCustomCoverFromFile])

  const handleListScroll = useCallback(() => {
    closeFolderPlaylistPopup()
  }, [closeFolderPlaylistPopup])

  const filteredPlaylists = useMemo(() => {
    const query = folderPlaylistSearch.trim().toLocaleLowerCase()
    if (!query) return playlists
    return playlists.filter((playlist) => playlist.name.toLocaleLowerCase().includes(query))
  }, [folderPlaylistSearch, playlists])

  const folderPlaylistPopupStyle = useMemo(() => {
    if (!folderPlaylistPopup) return undefined

    const panelWidth = 296
    const gap = 8
    const edgePadding = 10
    const estimatedHeight = 336

    let left = folderPlaylistPopup.anchor.right + gap
    if (left + panelWidth > window.innerWidth - edgePadding) {
      left = Math.max(edgePadding, folderPlaylistPopup.anchor.left - panelWidth - gap)
    }

    let top = folderPlaylistPopup.anchor.top - 8
    const maxTop = Math.max(edgePadding, window.innerHeight - edgePadding - estimatedHeight)
    top = Math.min(Math.max(top, edgePadding), maxTop)

    return {
      top,
      left,
      maxHeight: Math.max(170, window.innerHeight - top - edgePadding)
    }
  }, [folderPlaylistPopup])

  const currentTrackPath = currentTrack?.path ?? null
  const rowProps: RowSharedProps = useMemo(() => ({
    rows: visibleRows,
    currentTrackPath,
    onPlayTrack: handlePlayTrack,
    onShuffleFolder: handleShuffleFolder,
    onOpenPlaylistPopup: handleOpenPlaylistPopup,
    onToggleExpand: toggleExpand,
    expandedNodes,
    playlistPopupFolderPath: folderPlaylistPopup?.folderPath ?? null
  }), [
    currentTrackPath,
    expandedNodes,
    folderPlaylistPopup?.folderPath,
    handleOpenPlaylistPopup,
    handlePlayTrack,
    handleShuffleFolder,
    toggleExpand,
    visibleRows
  ])

  const content = tree.length === 0 ? (
    <div className="library-empty">
      {normalizedQuery
        ? <p>No tracks found for &ldquo;{searchQuery.trim()}&rdquo;</p>
        : <p>No folders with tracks</p>
      }
    </div>
  ) : (
    <div className="folder-browse-tree">
      <List
        className="folder-browse-virtualized"
        defaultHeight={TRACK_ROW_HEIGHT * 8}
        onScroll={handleListScroll}
        overscanCount={FOLDER_TREE_OVERSCAN_COUNT}
        rowComponent={MemoizedRow}
        rowCount={visibleRows.length}
        rowHeight={rowHeight}
        rowProps={rowProps}
        style={{ height: '100%', width: '100%' }}
      />
    </div>
  )

  return (
    <>
      {content}
      {folderPlaylistPopup && currentFolderPlaylistNode && (
        <div
          className="track-playlist-popup folder-playlist-popup"
          style={folderPlaylistPopupStyle}
          ref={folderPlaylistPopupRef}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="folder-playlist-popup-header">
            <div className="folder-playlist-popup-header-copy">
              <div className="folder-playlist-popup-title" title={currentFolderPlaylistNode.fullPath}>
                {currentFolderPlaylistNode.name}
              </div>
              <div className="folder-playlist-popup-subtitle">
                {currentFolderPlaylistNode.totalTrackCount} {currentFolderPlaylistNode.totalTrackCount === 1 ? 'visible track' : 'visible tracks'}
              </div>
            </div>
            <button
              type="button"
              className="folder-playlist-popup-create-btn"
              onClick={() => handleOpenCreatePlaylistModal()}
              disabled={isFolderPlaylistMutating}
            >
              New playlist
            </button>
          </div>
          <div className="track-playlist-popup-search">
            <input
              type="text"
              className="track-playlist-popup-search-input"
              placeholder="Search playlists..."
              value={folderPlaylistSearch}
              onChange={(event) => setFolderPlaylistSearch(event.target.value)}
              autoFocus
            />
          </div>
          {folderPlaylistFeedback && (
            <div className={`folder-playlist-popup-notice ${folderPlaylistFeedback.kind}`} role={folderPlaylistFeedback.kind === 'error' ? 'alert' : 'status'}>
              {folderPlaylistFeedback.message}
            </div>
          )}
          <div className="track-playlist-popup-list">
            {filteredPlaylists.length > 0 ? (
              filteredPlaylists.map((playlist) => (
                <button
                  key={playlist.id}
                  type="button"
                  className="track-playlist-popup-item folder-playlist-popup-item"
                  onClick={() => {
                    void handleAddFolderToPlaylist(playlist.id)
                  }}
                  disabled={isFolderPlaylistMutating}
                >
                  <PlaylistCover
                    hash={playlist.custom_cover_hash ?? playlist.auto_cover_hash}
                    name={playlist.name}
                    className="track-playlist-popup-cover"
                  />
                  <span className="track-playlist-popup-item-name">{playlist.name}</span>
                  <span className="folder-playlist-popup-item-count">
                    {playlist.track_count} {playlist.track_count === 1 ? 'track' : 'tracks'}
                  </span>
                </button>
              ))
            ) : (
              <div className="track-playlist-popup-empty">No matching playlists</div>
            )}
          </div>
        </div>
      )}
      <CreatePlaylistModal
        isOpen={createPlaylistTarget !== null}
        initialName={createPlaylistTarget?.folderName ?? ''}
        onClose={handleCloseCreatePlaylistModal}
        onCreate={handleCreatePlaylistFromFolder}
        title="Create Playlist from Folder"
      />
    </>
  )
}
