const RELEASES_API_URL = 'https://api.github.com/repos/Boof2015/astra/releases?per_page=20'
export const RELEASES_PAGE_URL = 'https://github.com/Boof2015/astra/releases'
const RELEASES_FETCH_TIMEOUT_MS = 10_000

type SemverIdentifier = number | string

interface ParsedSemverLike {
  major: number
  minor: number
  patch: number
  prerelease: SemverIdentifier[]
}

interface GitHubReleaseResponse {
  tag_name: string
  name: string | null
  html_url: string
  draft: boolean
  published_at?: string | null
  created_at?: string | null
}

export type UpdateCheckStatus = 'up-to-date' | 'update-available' | 'error'

export interface UpdateCheckResult {
  status: UpdateCheckStatus
  updateAvailable: boolean
  currentVersion: string
  latestTag: string | null
  latestVersion: string | null
  releaseName: string | null
  releaseUrl: string
  checkedAt: number
  message: string
}

function normalizeTag(value: string): string {
  return value
    .trim()
    .replace(/^refs\/tags\//i, '')
    .replace(/^v/i, '')
}

function parsePrerelease(value: string): SemverIdentifier[] {
  return value
    .split('.')
    .map((identifier) => identifier.trim())
    .filter((identifier) => identifier.length > 0)
    .map((identifier) => (/^\d+$/.test(identifier) ? Number(identifier) : identifier.toLowerCase()))
}

function parseSemverLike(tag: string): ParsedSemverLike | null {
  const normalized = normalizeTag(tag)
  const [withoutBuildMetadata] = normalized.split('+', 1)
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(withoutBuildMetadata)
  if (!match) return null

  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  const prerelease = match[4] ? parsePrerelease(match[4]) : []

  if ([major, minor, patch].some((part) => !Number.isFinite(part))) {
    return null
  }

  return { major, minor, patch, prerelease }
}

function compareSemverIdentifier(left: SemverIdentifier, right: SemverIdentifier): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right
  }
  if (typeof left === 'number' && typeof right === 'string') {
    return -1
  }
  if (typeof left === 'string' && typeof right === 'number') {
    return 1
  }
  return String(left).localeCompare(String(right))
}

function compareSemverLike(left: ParsedSemverLike, right: ParsedSemverLike): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch

  const leftHasPrerelease = left.prerelease.length > 0
  const rightHasPrerelease = right.prerelease.length > 0

  if (!leftHasPrerelease && !rightHasPrerelease) return 0
  if (!leftHasPrerelease) return 1
  if (!rightHasPrerelease) return -1

  const maxLength = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < maxLength; index += 1) {
    const leftIdentifier = left.prerelease[index]
    const rightIdentifier = right.prerelease[index]

    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1

    const result = compareSemverIdentifier(leftIdentifier, rightIdentifier)
    if (result !== 0) return result
  }

  return 0
}

function formatSemverLike(version: ParsedSemverLike): string {
  const prerelease = version.prerelease.length > 0 ? `-${version.prerelease.join('.')}` : ''
  return `${version.major}.${version.minor}.${version.patch}${prerelease}`
}

function resolveReleaseTimestamp(release: GitHubReleaseResponse): number {
  const publishedAt = release.published_at ? Date.parse(release.published_at) : NaN
  if (Number.isFinite(publishedAt)) {
    return publishedAt
  }

  const createdAt = release.created_at ? Date.parse(release.created_at) : NaN
  if (Number.isFinite(createdAt)) {
    return createdAt
  }

  return 0
}

async function fetchGitHubReleases(): Promise<GitHubReleaseResponse[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), RELEASES_FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(RELEASES_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Astra-Update-Check',
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`GitHub releases request failed with status ${response.status}`)
    }

    const payload: unknown = await response.json()
    if (!Array.isArray(payload)) {
      throw new Error('GitHub releases response was not an array')
    }

    return payload as GitHubReleaseResponse[]
  } finally {
    clearTimeout(timeout)
  }
}

function resolveLatestRelease(releases: GitHubReleaseResponse[]): GitHubReleaseResponse | null {
  const candidates = releases.filter((release) => !release.draft && release.tag_name.trim().length > 0)
  if (candidates.length === 0) {
    return null
  }

  const sorted = [...candidates].sort((left, right) => {
    return resolveReleaseTimestamp(right) - resolveReleaseTimestamp(left)
  })
  return sorted[0] ?? null
}

export async function checkForUpdates(currentVersion: string): Promise<UpdateCheckResult> {
  const checkedAt = Date.now()
  const normalizedCurrentVersion = normalizeTag(currentVersion)

  try {
    const releases = await fetchGitHubReleases()
    const latestRelease = resolveLatestRelease(releases)

    if (!latestRelease) {
      return {
        status: 'error',
        updateAvailable: false,
        currentVersion,
        latestTag: null,
        latestVersion: null,
        releaseName: null,
        releaseUrl: RELEASES_PAGE_URL,
        checkedAt,
        message: 'No published releases were found on GitHub.',
      }
    }

    const latestTag = latestRelease.tag_name.trim()
    const parsedCurrent = parseSemverLike(currentVersion)
    const parsedLatest = parseSemverLike(latestTag)

    const updateAvailable = parsedCurrent && parsedLatest
      ? compareSemverLike(parsedLatest, parsedCurrent) > 0
      : normalizeTag(latestTag) !== normalizedCurrentVersion

    const latestVersion = parsedLatest ? formatSemverLike(parsedLatest) : normalizeTag(latestTag)
    const releaseUrl = latestRelease.html_url?.trim() || RELEASES_PAGE_URL

    if (updateAvailable) {
      return {
        status: 'update-available',
        updateAvailable: true,
        currentVersion,
        latestTag,
        latestVersion,
        releaseName: latestRelease.name,
        releaseUrl,
        checkedAt,
        message: `Update available: ${latestTag} (current v${currentVersion}).`,
      }
    }

    return {
      status: 'up-to-date',
      updateAvailable: false,
      currentVersion,
      latestTag,
      latestVersion,
      releaseName: latestRelease.name,
      releaseUrl,
      checkedAt,
      message: `Astra is up to date (v${currentVersion}).`,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return {
      status: 'error',
      updateAvailable: false,
      currentVersion,
      latestTag: null,
      latestVersion: null,
      releaseName: null,
      releaseUrl: RELEASES_PAGE_URL,
      checkedAt,
      message: `Failed to check for updates: ${errorMessage}`,
    }
  }
}
