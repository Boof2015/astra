export interface FolderTreeTrack {
  path: string
}

export interface FolderTreeRoot {
  path: string
}

export interface FolderTreeNode<TTrack extends FolderTreeTrack = FolderTreeTrack> {
  name: string
  fullPath: string
  children: Map<string, FolderTreeNode<TTrack>>
  tracks: TTrack[]
  subtreeTracks: TTrack[]
  totalTrackCount: number
}

function normalizeFsPath(pathValue: string, platform: string): string {
  const slashNormalized = pathValue.replace(/\\/g, '/')
  const hasUncPrefix = /^\/\/[^/]/.test(slashNormalized)
  let normalized = slashNormalized.replace(/\/+/g, '/')

  if (hasUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`
  }

  if (normalized !== '/' && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.replace(/\/+$/, '')
  }

  return platform === 'darwin' ? normalized.normalize('NFC') : normalized
}

function foldComparableFsPath(normalizedPath: string, platform: string): string {
  return platform === 'win32' || platform === 'darwin'
    ? normalizedPath.toLocaleLowerCase()
    : normalizedPath
}

function normalizeComparableFsPath(pathValue: string, platform: string): string {
  return foldComparableFsPath(normalizeFsPath(pathValue, platform), platform)
}

export function getRelativeDescendantFsPath(
  candidatePath: string,
  ancestorPath: string,
  platform: string
): string | null {
  const normalizedCandidate = normalizeFsPath(candidatePath, platform)
  const normalizedAncestor = normalizeFsPath(ancestorPath, platform)
  if (!normalizedCandidate || !normalizedAncestor) return null

  const comparableCandidate = normalizeComparableFsPath(normalizedCandidate, platform)
  const comparableAncestor = normalizeComparableFsPath(normalizedAncestor, platform)
  if (comparableCandidate === comparableAncestor) return ''

  const ancestorWithSeparator = normalizedAncestor.endsWith('/')
    ? normalizedAncestor
    : `${normalizedAncestor}/`
  const comparableAncestorWithSeparator = foldComparableFsPath(ancestorWithSeparator, platform)
  if (!comparableCandidate.startsWith(comparableAncestorWithSeparator)) return null

  return normalizedCandidate.slice(ancestorWithSeparator.length)
}

export function isSameOrDescendantFsPath(
  candidatePath: string,
  ancestorPath: string,
  platform: string
): boolean {
  return getRelativeDescendantFsPath(candidatePath, ancestorPath, platform) !== null
}

function getFolderName(fullPath: string, platform: string): string {
  const normalized = normalizeFsPath(fullPath, platform)
  const parts = normalized.split('/')
  return parts[parts.length - 1] || fullPath
}

function appendFolderSegment(parentPath: string, segment: string): string {
  if (parentPath.endsWith('/') || parentPath.endsWith('\\')) {
    return `${parentPath}${segment}`
  }

  const separator = parentPath.includes('\\') && !parentPath.includes('/') ? '\\' : '/'
  return `${parentPath}${separator}${segment}`
}

function finalizeFolderNode<TTrack extends FolderTreeTrack>(node: FolderTreeNode<TTrack>): number {
  node.tracks.sort((a, b) => a.path.localeCompare(b.path))

  let totalTrackCount = node.tracks.length
  const subtreeTracks: TTrack[] = []
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

export function buildFolderTree<TTrack extends FolderTreeTrack>(
  folders: readonly FolderTreeRoot[],
  tracks: readonly TTrack[],
  platform: string
): FolderTreeNode<TTrack>[] {
  const rootEntries = folders.map((folder) => ({
    node: {
      name: getFolderName(folder.path, platform),
      fullPath: folder.path,
      children: new Map<string, FolderTreeNode<TTrack>>(),
      tracks: [],
      subtreeTracks: [],
      totalTrackCount: 0
    } satisfies FolderTreeNode<TTrack>,
    comparablePathLength: normalizeComparableFsPath(folder.path, platform).length
  }))

  const sortedRootEntries = [...rootEntries].sort((a, b) => (
    b.comparablePathLength - a.comparablePathLength
  ))

  for (const track of tracks) {
    let matchedRoot: FolderTreeNode<TTrack> | null = null
    let relativePath: string | null = null

    for (const rootEntry of sortedRootEntries) {
      const candidateRelativePath = getRelativeDescendantFsPath(track.path, rootEntry.node.fullPath, platform)
      if (candidateRelativePath === null || candidateRelativePath.length === 0) continue
      matchedRoot = rootEntry.node
      relativePath = candidateRelativePath
      break
    }

    if (!matchedRoot || relativePath === null) continue

    const segments = relativePath.split('/').filter((segment) => segment.length > 0)
    segments.pop()

    let current = matchedRoot
    let pathSoFar = matchedRoot.fullPath

    for (const segment of segments) {
      pathSoFar = appendFolderSegment(pathSoFar, segment)
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

  const roots = rootEntries.map((entry) => entry.node)
  roots.forEach(finalizeFolderNode)
  return roots.filter((root) => root.totalTrackCount > 0)
}

export function collectFolderNodePaths<TTrack extends FolderTreeTrack>(
  tree: readonly FolderTreeNode<TTrack>[]
): Set<string> {
  const paths = new Set<string>()

  const visit = (node: FolderTreeNode<TTrack>) => {
    paths.add(node.fullPath)
    for (const child of node.children.values()) {
      visit(child)
    }
  }

  tree.forEach(visit)
  return paths
}
