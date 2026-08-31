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

function valuesConflict(left: number | null, right: number | null): boolean {
  return left !== null && right !== null && left !== right
}

function releaseFactsCompatible<T>(left: PreparedTrack<T>, right: PreparedTrack<T>): boolean {
  if (left.year !== null && right.year !== null && Math.abs(left.year - right.year) > 1) return false
  if (valuesConflict(left.trackTotal, right.trackTotal)) return false
  if (valuesConflict(left.discTotal, right.discTotal)) return false
  return true
}

function partitionCompatibleTracks<T>(tracks: readonly PreparedTrack<T>[]): PreparedTrack<T>[][] {
  const partitions: PreparedTrack<T>[][] = []
  const sorted = [...tracks].sort((a, b) => a.trackId.localeCompare(b.trackId))
  for (const track of sorted) {
    const target = partitions.find((partition) => partition.every((candidate) => releaseFactsCompatible(track, candidate)))
    if (target) target.push(track)
    else partitions.push([track])
  }
  return partitions
}

function exactCommonYear<T>(tracks: readonly PreparedTrack<T>[]): number | null {
  if (tracks.length === 0 || tracks.some((track) => track.year === null)) return null
  const years = new Set(tracks.map((track) => track.year as number))
  return years.size === 1 ? Array.from(years)[0] : null
}

function coherentNumbering<T>(tracks: readonly PreparedTrack<T>[]): boolean {
  const numbered = tracks.filter((track) => track.trackNumber !== null && track.trackTotal !== null)
  if (numbered.length < 2) return false
  const positions = new Set<string>()
  for (const track of numbered) {
    if ((track.trackNumber ?? 0) < 1 || (track.trackNumber ?? 0) > (track.trackTotal ?? 0)) return false
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

function resolveCompilation<T>(tracks: readonly PreparedTrack<T>[]): {
  mode: 'shared-artwork-compilation' | 'metadata-compilation'
  artworkHash: string | null
} | null {
  if (new Set(tracks.map((track) => track.primaryArtistKey)).size <= 1) return null
  const artworkCounts = new Map<string, number>()
  for (const track of tracks) {
    if (!track.artworkIdentityHash) continue
    artworkCounts.set(track.artworkIdentityHash, (artworkCounts.get(track.artworkIdentityHash) ?? 0) + 1)
  }
  const rankedArtwork = Array.from(artworkCounts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const [dominantArtwork, dominantCount] = rankedArtwork[0] ?? [null, 0]
  const artworkTrackCount = Array.from(artworkCounts.values()).reduce((sum, count) => sum + count, 0)

  if (dominantArtwork && artworkTrackCount >= 2 && dominantCount === artworkTrackCount) {
    return { mode: 'shared-artwork-compilation', artworkHash: dominantArtwork }
  }
  if (
    dominantArtwork &&
    artworkTrackCount >= 5 &&
    dominantCount / artworkTrackCount >= 0.8 &&
    (exactCommonYear(tracks) !== null || coherentNumbering(tracks))
  ) {
    return { mode: 'shared-artwork-compilation', artworkHash: dominantArtwork }
  }
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
  const discTotal = tracks.find((track) => track.discTotal !== null)?.discTotal ?? null
  const trackTotal = tracks.find((track) => track.trackTotal !== null)?.trackTotal ?? null
  return `rp:y${year}:d${discTotal ?? 'u'}:t${trackTotal ?? 'u'}`
}

function addPreparedTracksToGroup<T>(group: AlbumIdentityGroup<T>, tracks: readonly PreparedTrack<T>[]): void {
  for (const track of tracks) group.tracks.push(track.track)
}

export function groupTracksByAlbumIdentity<T extends AlbumIdentityTrackLike>(
  tracks: readonly T[],
  getTrackId: (track: T) => string,
  providedArtistIndex?: ArtistIdentityIndex
): Map<string, AlbumIdentityGroup<T>> {
  const groups = new Map<string, AlbumIdentityGroup<T>>()
  const albumBuckets = new Map<string, PreparedTrack<T>[]>()
  const artistIndex = providedArtistIndex ?? buildArtistIdentityIndex(tracks)

  for (const track of tracks) {
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
    for (const track of missing) {
      const candidates = explicitPartitions.filter((partition) => {
        if (!partition.tracks.every((candidate) => releaseFactsCompatible(track, candidate))) return false
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
      if (candidates.length === 1) candidates[0].tracks.push(track)
      else remaining.push(track)
    }

    for (const partition of explicitPartitions) {
      const siblingCount = explicitPartitions.filter((candidate) => candidate.ownerKey === partition.ownerKey).length
      const discriminator = `aa:${partition.ownerKey}${siblingCount > 1 ? `:${releaseQualifier(partition.tracks)}` : ''}`
      const identityKey = buildCanonicalAlbumIdentityKey(bucket[0].albumKey, discriminator)
      const group = createAlbumIdentityGroup<T>(identityKey, bucket[0].albumKey, 'explicit-album-artist', partition.displayArtist)
      addPreparedTracksToGroup(group, partition.tracks)
      groups.set(identityKey, group)
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
        groups.set(identityKey, group)
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
          groups.set(identityKey, group)
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
