import {
  buildArtistIdentityIndex,
  canonicalizeArtistDisplay,
  formatArtistNames,
  normalizeArtistDisplay,
  normalizeArtistKey,
  normalizeIdentityKey,
  resolveArtistCredit,
  resolveTrackArtistNames,
  type ArtistIdentityIndex,
  type ArtistIdentityTrackLike
} from './artistCredits.ts'

export interface AlbumIdentityArtistTrackLike extends ArtistIdentityTrackLike {}

export interface AlbumIdentityTrackLike extends AlbumIdentityArtistTrackLike {
  album: string
  artwork_hash?: string | null
  base_artwork_hash?: string | null
  year?: number | null
  track_number?: number | null
  track_total?: number | null
  disc_number?: number | null
  disc_total?: number | null
}

export type AlbumGroupingMode =
  | 'explicit-album-artist'
  | 'shared-artwork-compilation'
  | 'metadata-compilation'
  | 'track-artist'

export interface AlbumIdentityGroup<T> {
  identityKey: string
  albumKey: string
  groupingMode: AlbumGroupingMode
  displayArtist: string
  tracks: T[]
}

const UNKNOWN_ALBUM_NAME = 'Unknown Album'
const UNKNOWN_ARTIST_NAME = 'Unknown Artist'
const VARIOUS_ARTISTS_NAME = 'Various Artists'

interface PreparedTrack<T> {
  track: T
  trackId: string
  albumKey: string
  normalizedAlbumArtist: string
  primaryArtist: string
  primaryArtistKey: string
  creditArtistKeys: readonly string[]
  artworkIdentityHash: string | null
  year: number | null
  trackNumber: number | null
  trackTotal: number | null
  discNumber: number | null
  discTotal: number | null
}

export function normalizeDisplay(value: string): string {
  return normalizeArtistDisplay(value)
}

export function normalizeKey(value: string): string {
  return normalizeIdentityKey(value)
}

export function normalizeAlbumName(album: string): string {
  const normalized = normalizeDisplay(album)
  return normalized || UNKNOWN_ALBUM_NAME
}

export function normalizeArtworkHash(hash: string | null | undefined): string | null {
  const normalized = normalizeDisplay(hash ?? '')
  return normalized ? normalized.toLocaleLowerCase() : null
}

export function splitCollaborators(rawArtist: string, index?: ArtistIdentityIndex): string[] {
  const resolvedIndex = index ?? buildArtistIdentityIndex([{ artist: rawArtist }])
  return resolveArtistCredit(rawArtist, resolvedIndex)
}

export function getPrimaryArtistFromTrackArtist(trackArtist: string): string {
  const contributors = splitCollaborators(trackArtist)
  return contributors[0] ?? UNKNOWN_ARTIST_NAME
}

function getPrimaryArtistFromTrack<T extends AlbumIdentityArtistTrackLike>(
  track: T,
  index: ArtistIdentityIndex
): string {
  return resolveTrackArtistNames(track, index)[0] ?? UNKNOWN_ARTIST_NAME
}

function getNormalizedAlbumArtist<T extends AlbumIdentityArtistTrackLike>(track: T): string {
  const normalizedAlbumArtist = normalizeDisplay(track.album_artist ?? '')
  if (normalizedAlbumArtist) return canonicalizeArtistDisplay(normalizedAlbumArtist)

  const index = buildArtistIdentityIndex([track])
  const parsedAlbumArtists = resolveTrackArtistNames(track, index, true)
  if (parsedAlbumArtists.length > 0) return formatArtistNames(parsedAlbumArtists)
  return ''
}

export function buildCanonicalAlbumIdentityKey(albumKey: string, discriminator: string): string {
  return `album:${albumKey}::${discriminator}`
}

export function buildAlbumIdentityKeyFromTrack(track: AlbumIdentityTrackLike): string {
  const artistIndex = buildArtistIdentityIndex([track])
  const albumKey = normalizeKey(normalizeAlbumName(track.album))
  const normalizedAlbumArtist = getNormalizedAlbumArtist(track)
  if (normalizedAlbumArtist) {
    const albumArtistKey = normalizeArtistKey(normalizedAlbumArtist) || normalizeArtistKey(UNKNOWN_ARTIST_NAME)
    return buildCanonicalAlbumIdentityKey(albumKey, `aa:${albumArtistKey}`)
  }

  const primaryArtist = normalizeDisplay(getPrimaryArtistFromTrack(track, artistIndex)) || UNKNOWN_ARTIST_NAME
  const primaryArtistKey = normalizeArtistKey(primaryArtist) || normalizeArtistKey(UNKNOWN_ARTIST_NAME)
  return buildCanonicalAlbumIdentityKey(albumKey, `ta:${primaryArtistKey}`)
}

function createAlbumIdentityGroup<T>(
  identityKey: string,
  albumKey: string,
  groupingMode: AlbumGroupingMode,
  displayArtist: string
): AlbumIdentityGroup<T> {
  return {
    identityKey,
    albumKey,
    groupingMode,
    displayArtist,
    tracks: []
  }
}

function releaseTotalsCompatible<T>(tracks: readonly PreparedTrack<T>[]): boolean {
  const discTotals = new Set<number>()
  const totalsByDisc = new Map<number, number>()
  const unknownDiscTotals = new Set<number>()
  for (const track of tracks) {
    if (track.discTotal !== null) discTotals.add(track.discTotal)
    if (track.trackTotal === null) continue
    if (track.discNumber === null || track.discNumber < 1) {
      unknownDiscTotals.add(track.trackTotal)
    } else {
      const total = totalsByDisc.get(track.discNumber)
      if (total !== undefined && total !== track.trackTotal) return false
      totalsByDisc.set(track.discNumber, track.trackTotal)
    }
  }
  if (discTotals.size > 1 || unknownDiscTotals.size > 1) return false
  const [unknownDiscTotal] = unknownDiscTotals
  return unknownDiscTotal === undefined || Array.from(totalsByDisc.values()).every((total) => total === unknownDiscTotal)
}

function strictReleaseGroupCompatible<T>(tracks: readonly PreparedTrack<T>[]): boolean {
  if (!releaseTotalsCompatible(tracks)) return false
  let earliest = Infinity
  let latest = -Infinity
  for (const track of tracks) {
    if (track.year === null) continue
    earliest = Math.min(earliest, track.year)
    latest = Math.max(latest, track.year)
  }
  return latest - earliest <= 1
}

// A date disagreement needs positive evidence from each dated side. Unknown
// dates and unnumbered tracks must not supply the evidence for that override.
function releaseGroupCompatible<T>(tracks: readonly PreparedTrack<T>[]): boolean {
  if (!releaseTotalsCompatible(tracks)) return false
  const years = Array.from(new Set(tracks.flatMap((track) => track.year === null ? [] : [track.year])))
  const disputedYears = years.filter((year) => years.some((other) => Math.abs(year - other) > 1))
  if (disputedYears.length === 0) return true
  if (!coherentNumbering(tracks)) return false
  if (!disputedYears.every((year) => tracks.some((track) => track.year === year && track.trackNumber !== null))) {
    return false
  }

  const owners = new Set(tracks.map((track) => normalizeArtistKey(track.normalizedAlbumArtist)))
  if (owners.size === 1 && !owners.has('')) return true
  if (Array.from(owners).filter(Boolean).length > 1) return false

  const artwork = sharedArtworkEvidence(tracks)
  return artwork !== null && disputedYears.every((year) => tracks.some(
    (track) => track.year === year && track.artworkIdentityHash === artwork
  ))
}

function mergeCompatiblePartitions<T>(
  partitions: PreparedTrack<T>[][],
  compatible: (tracks: readonly PreparedTrack<T>[]) => boolean = releaseGroupCompatible
): PreparedTrack<T>[][] {
  const neighbors = partitions.map(() => new Set<number>())
  for (let left = 0; left < partitions.length; left += 1) {
    for (let right = left + 1; right < partitions.length; right += 1) {
      if (!compatible([...partitions[left], ...partitions[right]])) continue
      neighbors[left].add(right)
      neighbors[right].add(left)
    }
  }
  const visited = new Set<number>()
  const merged: PreparedTrack<T>[][] = []
  for (let start = 0; start < partitions.length; start += 1) {
    if (visited.has(start)) continue
    const component = [start]
    visited.add(start)
    for (let cursor = 0; cursor < component.length; cursor += 1) {
      for (const neighbor of neighbors[component[cursor]]) {
        if (visited.has(neighbor)) continue
        visited.add(neighbor)
        component.push(neighbor)
      }
    }
    const tracks = component.flatMap((index) => partitions[index])
    // Never choose an arbitrary subset when two individually plausible joins
    // would produce conflicting tracklists together.
    if (compatible(tracks)) merged.push(tracks)
    else merged.push(...component.map((index) => partitions[index]))
  }
  return merged
}

function partitionCompatibleTracks<T>(tracks: readonly PreparedTrack<T>[]): PreparedTrack<T>[][] {
  if (tracks.length === 0) return []
  const specificity = (track: PreparedTrack<T>): number =>
    Number(track.trackTotal !== null) + Number(track.discTotal !== null) + Number(track.discNumber !== null)
  const sorted = [...tracks].sort((a, b) => specificity(b) - specificity(a) ||
    (a.year ?? 0) - (b.year ?? 0) || a.trackId.localeCompare(b.trackId))
  const hasDatedTracks = sorted.some((track) => track.year !== null)
  const deferred: PreparedTrack<T>[] = []
  const byFacts = new Map<string, PreparedTrack<T>[]>()
  for (const track of sorted) {
    if (hasDatedTracks && track.year === null) {
      deferred.push(track)
      continue
    }
    const key = JSON.stringify([track.year, track.discTotal, track.discNumber, track.trackTotal])
    const partition = byFacts.get(key)
    if (partition) partition.push(track)
    else byFacts.set(key, [track])
  }
  // Start with exact fact cohorts, not first-fit assignments. Otherwise a disc
  // compatible with two editions could be claimed by whichever path sorts first.
  // Consolidate ordinary releases before evaluating stronger cross-year joins.
  const partitions = mergeCompatiblePartitions(Array.from(byFacts.values()), strictReleaseGroupCompatible)
  const merged = mergeCompatiblePartitions(partitions)

  // Establish incompatible undated releases before assigning any wildcard
  // tracks, so a later candidate cannot invalidate an earlier unique match.
  const pending: PreparedTrack<T>[] = []
  for (const track of deferred) {
    if (merged.some((partition) => releaseGroupCompatible([...partition, track]))) pending.push(track)
    else merged.push([track])
  }
  const additions = new Map<PreparedTrack<T>[], PreparedTrack<T>[]>()
  const remaining: PreparedTrack<T>[] = []
  for (const track of pending) {
    const candidates = merged.filter((partition) => releaseGroupCompatible([...partition, track]))
    if (candidates.length !== 1) {
      remaining.push(track)
      continue
    }
    const target = candidates[0]
    additions.set(target, [...(additions.get(target) ?? []), track])
  }
  for (const [target, proposed] of additions) {
    if (releaseGroupCompatible([...target, ...proposed])) target.push(...proposed)
    else remaining.push(...proposed)
  }
  return [...merged, ...partitionCompatibleTracks(remaining)]
}

function exactCommonYear<T>(tracks: readonly PreparedTrack<T>[]): number | null {
  if (tracks.length === 0 || tracks.some((track) => track.year === null)) return null
  const years = new Set(tracks.map((track) => track.year as number))
  return years.size === 1 ? Array.from(years)[0] : null
}

function coherentNumbering<T>(tracks: readonly PreparedTrack<T>[]): boolean {
  const numbered = tracks.filter((track) => track.trackNumber !== null)
  if (numbered.length < 2) return false
  const multiDisc = tracks.some((track) => (track.discNumber ?? 1) > 1 || (track.discTotal ?? 1) > 1)
  const positions = new Set<string>()
  for (const track of numbered) {
    if ((track.trackNumber ?? 0) < 1) return false
    if (track.trackTotal !== null && (track.trackNumber ?? 0) > track.trackTotal) return false
    if (multiDisc && track.discNumber === null) return false
    if ((track.discNumber ?? 1) < 1 || (track.discTotal !== null && (track.discNumber ?? 1) > track.discTotal)) return false
    const position = `${track.discNumber ?? 1}:${track.trackNumber}`
    if (positions.has(position)) return false
    positions.add(position)
  }
  return true
}

function completeNumbering<T>(tracks: readonly PreparedTrack<T>[]): boolean {
  if (tracks.length < 4 || exactCommonYear(tracks) === null) return false
  if (tracks.some((track) => track.trackNumber === null || track.trackTotal === null)) return false

  const discTotals = new Set(tracks.map((track) => track.discTotal).filter((value): value is number => value !== null))
  if (discTotals.size > 1) return false
  const expectedDiscTotal = discTotals.size === 1 ? Array.from(discTotals)[0] : 1
  const byDisc = new Map<number, PreparedTrack<T>[]>()
  for (const track of tracks) {
    const disc = track.discNumber ?? 1
    if (disc < 1 || disc > expectedDiscTotal) return false
    const group = byDisc.get(disc)
    if (group) group.push(track)
    else byDisc.set(disc, [track])
  }
  if (byDisc.size !== expectedDiscTotal) return false

  for (let disc = 1; disc <= expectedDiscTotal; disc += 1) {
    const group = byDisc.get(disc) ?? []
    const totals = new Set(group.map((track) => track.trackTotal as number))
    if (totals.size !== 1) return false
    const total = Array.from(totals)[0]
    const positions = new Set(group.map((track) => track.trackNumber as number))
    if (positions.size !== total) return false
    for (let position = 1; position <= total; position += 1) {
      if (!positions.has(position)) return false
    }
  }
  return true
}

function sharedArtworkEvidence<T>(tracks: readonly PreparedTrack<T>[]): string | null {
  const artworkCounts = new Map<string, number>()
  for (const track of tracks) {
    if (!track.artworkIdentityHash) continue
    artworkCounts.set(track.artworkIdentityHash, (artworkCounts.get(track.artworkIdentityHash) ?? 0) + 1)
  }
  const rankedArtwork = Array.from(artworkCounts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const [dominantArtwork, dominantCount] = rankedArtwork[0] ?? [null, 0]
  const artworkTrackCount = Array.from(artworkCounts.values()).reduce((sum, count) => sum + count, 0)

  if (dominantArtwork && artworkTrackCount >= 2 && dominantCount === artworkTrackCount) {
    return dominantArtwork
  }
  if (
    dominantArtwork &&
    artworkTrackCount >= 5 &&
    dominantCount / artworkTrackCount >= 0.8 &&
    (exactCommonYear(tracks) !== null || coherentNumbering(tracks))
  ) {
    return dominantArtwork
  }
  return null
}

function resolveCompilation<T>(tracks: readonly PreparedTrack<T>[]): {
  mode: 'shared-artwork-compilation' | 'metadata-compilation'
  artworkHash: string | null
} | null {
  if (new Set(tracks.map((track) => track.primaryArtistKey)).size <= 1) return null
  const artworkHash = sharedArtworkEvidence(tracks)
  if (artworkHash) return { mode: 'shared-artwork-compilation', artworkHash }
  if (completeNumbering(tracks)) return { mode: 'metadata-compilation', artworkHash: null }
  return null
}

function releaseQualifier<T>(tracks: readonly PreparedTrack<T>[]): string {
  const years = Array.from(new Set(
    tracks.map((track) => track.year).filter((value): value is number => value !== null)
  )).sort((a, b) => a - b)
  const year = years.length === 0
    ? 'u'
    : years.length === 1
      ? String(years[0])
      : `${years[0]}-${years[years.length - 1]}`
  const discTotals = Array.from(new Set(tracks.flatMap((track) => track.discTotal === null ? [] : [track.discTotal])))
    .sort((a, b) => a - b)
  const totalsByDisc = new Map<number, Set<number>>()
  for (const track of tracks) {
    if (track.trackTotal === null) continue
    const disc = track.discNumber ?? 0
    const totals = totalsByDisc.get(disc) ?? new Set<number>()
    totals.add(track.trackTotal)
    totalsByDisc.set(disc, totals)
  }
  const trackTotals = Array.from(totalsByDisc).sort(([a], [b]) => a - b)
    .map(([disc, totals]) => `${disc || 'u'}=${Array.from(totals).sort((a, b) => a - b).join(',')}`).join(';')
  return `rp:y${year}:d${discTotals.join(',') || 'u'}:t${trackTotals || 'u'}`
}

function addPreparedTracksToGroup<T>(group: AlbumIdentityGroup<T>, tracks: readonly PreparedTrack<T>[]): void {
  for (const track of [...tracks].sort((a, b) => a.trackId.localeCompare(b.trackId))) group.tracks.push(track.track)
}

function storeAlbumGroup<T>(groups: Map<string, AlbumIdentityGroup<T>>, group: AlbumIdentityGroup<T>): void {
  const baseKey = group.identityKey
  let suffix = 2
  // Ambiguous groups can have identical release facts. Never overwrite tracks
  // just because their conservative partitions need the same qualifier.
  while (groups.has(group.identityKey)) group.identityKey = `${baseKey}:p${suffix++}`
  groups.set(group.identityKey, group)
}

export function groupTracksByAlbumIdentity<T extends AlbumIdentityTrackLike>(
  tracks: readonly T[],
  getTrackId: (track: T) => string,
  providedArtistIndex?: ArtistIdentityIndex
): Map<string, AlbumIdentityGroup<T>> {
  const groups = new Map<string, AlbumIdentityGroup<T>>()
  const albumBuckets = new Map<string, PreparedTrack<T>[]>()
  const artistIndex = providedArtistIndex ?? buildArtistIdentityIndex(tracks)

  for (const track of [...tracks].sort((a, b) => getTrackId(a).localeCompare(getTrackId(b)))) {
    const trackId = getTrackId(track)
    const albumKey = normalizeKey(normalizeAlbumName(track.album))
    const normalizedAlbumArtist = getNormalizedAlbumArtist(track)
    const creditArtists = resolveTrackArtistNames(track, artistIndex)
    const primaryArtist = normalizeDisplay(creditArtists[0]) || UNKNOWN_ARTIST_NAME
    const primaryArtistKey = normalizeArtistKey(primaryArtist) || normalizeArtistKey(UNKNOWN_ARTIST_NAME)
    const artworkIdentityHash = normalizeArtworkHash(track.base_artwork_hash)

    const bucket = albumBuckets.get(albumKey)
    const preparedTrack: PreparedTrack<T> = {
      track,
      trackId,
      albumKey,
      normalizedAlbumArtist,
      primaryArtist,
      primaryArtistKey,
      creditArtistKeys: creditArtists.map(normalizeArtistKey).filter(Boolean),
      artworkIdentityHash,
      year: Number.isInteger(track.year) ? track.year ?? null : null,
      trackNumber: Number.isInteger(track.track_number) ? track.track_number ?? null : null,
      trackTotal: Number.isInteger(track.track_total) ? track.track_total ?? null : null,
      discNumber: Number.isInteger(track.disc_number) ? track.disc_number ?? null : null,
      discTotal: Number.isInteger(track.disc_total) ? track.disc_total ?? null : null
    }

    if (bucket) {
      bucket.push(preparedTrack)
    } else {
      albumBuckets.set(albumKey, [preparedTrack])
    }
  }

  for (const bucket of albumBuckets.values()) {
    const explicitByOwner = new Map<string, PreparedTrack<T>[]>()
    const missing: PreparedTrack<T>[] = []
    for (const track of bucket) {
      if (!track.normalizedAlbumArtist) {
        missing.push(track)
        continue
      }
      const ownerKey = normalizeArtistKey(track.normalizedAlbumArtist) || normalizeArtistKey(UNKNOWN_ARTIST_NAME)
      const ownerTracks = explicitByOwner.get(ownerKey)
      if (ownerTracks) ownerTracks.push(track)
      else explicitByOwner.set(ownerKey, [track])
    }

    const explicitPartitions: Array<{ ownerKey: string; displayArtist: string; tracks: PreparedTrack<T>[] }> = []
    for (const [ownerKey, ownerTracks] of explicitByOwner) {
      for (const partition of partitionCompatibleTracks(ownerTracks)) {
        explicitPartitions.push({ ownerKey, displayArtist: partition[0].normalizedAlbumArtist, tracks: partition })
      }
    }

    const remaining: PreparedTrack<T>[] = []
    const ownerAdditions = new Map<typeof explicitPartitions[number], PreparedTrack<T>[]>()
    for (const track of missing) {
      const candidates = explicitPartitions.filter((partition) => {
        if (!releaseGroupCompatible([...partition.tracks, track])) return false
        const targetCreditKeys = new Set([
          partition.ownerKey,
          ...partition.tracks.flatMap((candidate) => candidate.creditArtistKeys)
        ])
        const artistMatch = track.creditArtistKeys.some((key) => targetCreditKeys.has(key))
        const artworkMatch = Boolean(track.artworkIdentityHash) && partition.tracks.some(
          (candidate) => candidate.artworkIdentityHash === track.artworkIdentityHash
        )
        const yearAndNumbering = track.year !== null && partition.tracks.some(
          (candidate) => candidate.year === track.year
        ) && coherentNumbering([...partition.tracks, track])
        return artistMatch || artworkMatch || yearAndNumbering
      })
      if (candidates.length === 1) {
        const target = candidates[0]
        ownerAdditions.set(target, [...(ownerAdditions.get(target) ?? []), track])
      } else remaining.push(track)
    }
    for (const [target, proposed] of ownerAdditions) {
      if (releaseGroupCompatible([...target.tracks, ...proposed])) target.tracks.push(...proposed)
      else remaining.push(...proposed)
    }

    for (const partition of explicitPartitions) {
      const siblingCount = explicitPartitions.filter((candidate) => candidate.ownerKey === partition.ownerKey).length
      const discriminator = `aa:${partition.ownerKey}${siblingCount > 1 ? `:${releaseQualifier(partition.tracks)}` : ''}`
      const identityKey = buildCanonicalAlbumIdentityKey(bucket[0].albumKey, discriminator)
      const group = createAlbumIdentityGroup<T>(identityKey, bucket[0].albumKey, 'explicit-album-artist', partition.displayArtist)
      addPreparedTracksToGroup(group, partition.tracks)
      storeAlbumGroup(groups, group)
    }

    const releasePartitions = partitionCompatibleTracks(remaining)
    const primaryPartitionCounts = new Map<string, number>()
    for (const partition of releasePartitions) {
      for (const primaryKey of new Set(partition.map((track) => track.primaryArtistKey))) {
        primaryPartitionCounts.set(primaryKey, (primaryPartitionCounts.get(primaryKey) ?? 0) + 1)
      }
    }
    for (const releasePartition of releasePartitions) {
      const compilation = bucket[0].albumKey !== normalizeKey(UNKNOWN_ALBUM_NAME)
        ? resolveCompilation(releasePartition)
        : null
      if (compilation) {
        const discriminator = compilation.artworkHash
          ? `ah:${compilation.artworkHash}`
          : `ci:${releaseQualifier(releasePartition)}`
        let identityKey = buildCanonicalAlbumIdentityKey(bucket[0].albumKey, discriminator)
        if (groups.has(identityKey)) {
          identityKey = buildCanonicalAlbumIdentityKey(
            bucket[0].albumKey,
            `${discriminator}:${releaseQualifier(releasePartition)}`
          )
        }
        const group = createAlbumIdentityGroup<T>(identityKey, bucket[0].albumKey, compilation.mode, VARIOUS_ARTISTS_NAME)
        addPreparedTracksToGroup(group, releasePartition)
        storeAlbumGroup(groups, group)
        continue
      }

      const byPrimary = new Map<string, PreparedTrack<T>[]>()
      for (const track of releasePartition) {
        const primaryTracks = byPrimary.get(track.primaryArtistKey)
        if (primaryTracks) primaryTracks.push(track)
        else byPrimary.set(track.primaryArtistKey, [track])
      }
      for (const [primaryKey, primaryTracks] of byPrimary) {
        const samePrimaryPartitions = partitionCompatibleTracks(primaryTracks)
        for (let index = 0; index < samePrimaryPartitions.length; index += 1) {
          const partition = samePrimaryPartitions[index]
          const needsQualifier = (primaryPartitionCounts.get(primaryKey) ?? 0) > 1 || samePrimaryPartitions.length > 1
          const discriminator = `ta:${primaryKey}${needsQualifier ? `:${releaseQualifier(partition)}` : ''}`
          const identityKey = buildCanonicalAlbumIdentityKey(bucket[0].albumKey, discriminator)
          const group = createAlbumIdentityGroup<T>(identityKey, bucket[0].albumKey, 'track-artist', partition[0].primaryArtist)
          addPreparedTracksToGroup(group, partition)
          storeAlbumGroup(groups, group)
        }
      }
    }
  }

  return groups
}

export function buildAlbumIdentityKeyByTrackId<T extends AlbumIdentityTrackLike>(
  tracks: readonly T[],
  getTrackId: (track: T) => string,
  artistIndex?: ArtistIdentityIndex
): Map<string, string> {
  const keysByTrackId = new Map<string, string>()
  const groups = groupTracksByAlbumIdentity(tracks, getTrackId, artistIndex)

  for (const [identityKey, group] of groups.entries()) {
    for (const track of group.tracks) {
      keysByTrackId.set(getTrackId(track), identityKey)
    }
  }

  return keysByTrackId
}
