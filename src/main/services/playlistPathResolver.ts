import { posix, win32 } from 'path'
import { fileURLToPath } from 'url'

export type PlaylistPathResolverPlatform = 'posix' | 'win32'

export interface ResolvedPlaylistImportPath {
  normalizedPath: string
  caseInsensitivePath: string
}

export interface PlaylistPathResolverOptions {
  platform?: PlaylistPathResolverPlatform
}

type FileURLToPathOptions = {
  windows?: boolean
}

const fileURLToPathWithOptions = fileURLToPath as (url: string | URL, options?: FileURLToPathOptions) => string

function getCurrentResolverPlatform(): PlaylistPathResolverPlatform {
  return process.platform === 'win32' ? 'win32' : 'posix'
}

function getPathApi(platform: PlaylistPathResolverPlatform): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix
}

function normalizeSeparatorsForPlatform(inputPath: string, platform: PlaylistPathResolverPlatform): string {
  return platform === 'win32'
    ? inputPath.replace(/\//g, '\\')
    : inputPath.replace(/\\/g, '/')
}

function isWindowsAbsolutePath(inputPath: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(inputPath)
    || /^\\\\[^\\]/.test(inputPath)
    || /^\/\/[^/]/.test(inputPath)
}

function isWindowsDriveFileUrl(inputPath: string): boolean {
  try {
    const parsed = new URL(inputPath)
    return parsed.protocol.toLocaleLowerCase() === 'file:'
      && /^\/[a-zA-Z][:|]\//.test(parsed.pathname)
  } catch {
    return /^file:(?:\/\/localhost)?\/+[a-zA-Z][:|][\\/]/i.test(inputPath)
  }
}

export function stripPlaylistEntryOuterQuotes(value: string): string {
  if (value.length < 2) return value
  const startsWithSingle = value.startsWith("'") && value.endsWith("'")
  const startsWithDouble = value.startsWith('"') && value.endsWith('"')
  if (!startsWithSingle && !startsWithDouble) return value
  return value.slice(1, -1)
}

export function normalizePlaylistPathForLookup(
  inputPath: string,
  options: PlaylistPathResolverOptions = {}
): string {
  const trimmed = inputPath.trim()
  if (!trimmed) return ''

  const platform = options.platform ?? getCurrentResolverPlatform()
  return getPathApi(platform).normalize(normalizeSeparatorsForPlatform(trimmed, platform))
}

function resolveImportedPlaylistEntryPathCandidate(
  candidatePath: string,
  importFilePath: string,
  platform: PlaylistPathResolverPlatform
): ResolvedPlaylistImportPath | null {
  const pathApi = getPathApi(platform)
  const windowsAbsolutePath = isWindowsAbsolutePath(candidatePath)
  let absolutePath = candidatePath

  if (windowsAbsolutePath && platform !== 'win32') {
    // Preserve explicit Windows paths on POSIX so imported Windows playlists can
    // still match Windows-style library paths stored from another environment.
    absolutePath = candidatePath
  } else {
    const normalizedSeparators = normalizeSeparatorsForPlatform(candidatePath, platform)
    absolutePath = pathApi.isAbsolute(normalizedSeparators)
      ? normalizedSeparators
      : pathApi.resolve(pathApi.dirname(importFilePath), normalizedSeparators)
  }

  const normalizedPath = normalizePlaylistPathForLookup(absolutePath, { platform })
  if (!normalizedPath) return null

  return {
    normalizedPath,
    caseInsensitivePath: normalizedPath.toLocaleLowerCase()
  }
}

function decodeUriEncodedPlaylistPath(candidatePath: string): string | null {
  if (!candidatePath.includes('%')) return null

  try {
    const decodedPath = decodeURIComponent(candidatePath)
    return decodedPath !== candidatePath ? decodedPath : null
  } catch {
    return null
  }
}

function pushUniquePath(paths: string[], pathValue: string): void {
  if (paths.includes(pathValue)) return
  paths.push(pathValue)
}

function pushFileUrlPathCandidate(
  candidatePaths: string[],
  rawPath: string,
  windows: boolean
): void {
  try {
    pushUniquePath(candidatePaths, fileURLToPathWithOptions(rawPath, { windows }))
  } catch {
    // Invalid file URI candidates are treated like unsupported playlist paths.
  }
}

function resolveFileUrlPathCandidates(
  rawPath: string,
  platform: PlaylistPathResolverPlatform
): string[] {
  const candidatePaths: string[] = []
  pushFileUrlPathCandidate(candidatePaths, rawPath, platform === 'win32')

  if (platform !== 'win32' && isWindowsDriveFileUrl(rawPath)) {
    pushFileUrlPathCandidate(candidatePaths, rawPath, true)
  }

  return candidatePaths
}

export function resolveImportedPlaylistEntryPaths(
  rawPath: string,
  importFilePath: string,
  options: PlaylistPathResolverOptions = {}
): ResolvedPlaylistImportPath[] | null {
  const trimmed = stripPlaylistEntryOuterQuotes(rawPath.trim())
  if (!trimmed) return null

  const platform = options.platform ?? getCurrentResolverPlatform()
  const windowsAbsolutePath = isWindowsAbsolutePath(trimmed)
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)
  const candidatePaths: string[] = []

  if (schemeMatch && !windowsAbsolutePath) {
    const scheme = schemeMatch[1].toLocaleLowerCase()
    if (scheme !== 'file') return null
    candidatePaths.push(...resolveFileUrlPathCandidates(trimmed, platform))
  } else {
    candidatePaths.push(trimmed)

    // Some M3U exporters percent-encode plain local paths without a file:// scheme.
    const decodedPath = decodeUriEncodedPlaylistPath(trimmed)
    if (decodedPath) {
      candidatePaths.push(decodedPath)
    }
  }

  const resolvedPaths: ResolvedPlaylistImportPath[] = []
  const seenNormalizedPaths = new Set<string>()
  for (const candidatePath of candidatePaths) {
    const resolvedPath = resolveImportedPlaylistEntryPathCandidate(candidatePath, importFilePath, platform)
    if (!resolvedPath || seenNormalizedPaths.has(resolvedPath.normalizedPath)) continue
    seenNormalizedPaths.add(resolvedPath.normalizedPath)
    resolvedPaths.push(resolvedPath)
  }

  return resolvedPaths.length > 0 ? resolvedPaths : null
}
