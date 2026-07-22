import { spawn } from 'child_process'
import { createReadStream } from 'fs'
import { open, stat } from 'fs/promises'
import { createHash } from 'crypto'
import { cpus } from 'os'
import { basename, extname } from 'path'
import * as mm from 'music-metadata'
import type {
  IntegrityDuplicateGroup,
  IntegrityDuplicateMember,
  IntegrityFinding,
  IntegrityScanMode,
  IntegrityScanScope
} from '../../types/libraryIntegrity'
import { getMusicMetadataParseOptions } from '../utils/musicMetadata'

export interface IntegrityScanTrackTarget {
  path: string
  title: string
  artist: string
  album: string
  duration: number
  format: string
  sampleRate: number | null
  bitDepth: number | null
  bitrate: number | null
  channels: number | null
}

export interface FlacStreamInfo {
  minBlockSize: number
  maxBlockSize: number
  minFrameSize: number
  maxFrameSize: number
  sampleRate: number
  channels: number
  bitsPerSample: number
  totalSamples: number
  md5: string
}

export type IntegrityFindingInput = Omit<IntegrityFinding, 'id'>

interface IntegrityWorkerOptions {
  signal?: AbortSignal
  onBattery?: boolean
}

export interface IntegrityDuplicateSnapshotMember {
  path: string
  title: string
  artist: string
  duration: number
  sizeBytes: number
  modifiedAtMs: number
}

export interface IntegrityDuplicateScanOutput {
  groups: IntegrityDuplicateGroup[]
  findings: IntegrityFindingInput[]
  snapshots: Map<string, IntegrityDuplicateSnapshotMember>
  scanned: number
  skipped: number
}

export interface IntegrityDuplicateCandidate extends IntegrityScanTrackTarget {
  sizeBytes: number
  modifiedAtMs: number
  contentHash?: string
}

interface IntegrityDuplicateScanOptions extends IntegrityWorkerOptions {
  onProgress?: (current: number, total: number, filePath: string, message: string) => void
}

interface PcmAnalysisStats {
  sourceBitDepth: number | null
  lowBitSampleCount: number
  lowBitNonZeroCount: number
  spectralWindowCount: number
  spectralTotalEnergy: number
  ultrasonicEnergy: number
  presenceEnergy: number
  topAudibleEnergy: number
  nyquist: number
}

type PcmOutputFormat = 's16le' | 's24le'

const QUICK_SCAN_PARALLEL_MIN_FILES = 200
const QUICK_SCAN_PARALLEL_MIN_WORKERS = 2
const QUICK_SCAN_PARALLEL_MAX_WORKERS = 4
const DEEP_SCAN_PARALLEL_MIN_FILES = 2
const DEEP_SCAN_PARALLEL_MAX_WORKERS = 2
const FLAC_STREAMINFO_LENGTH = 34
const FLAC_METADATA_HEADER_LENGTH = 4
const MAX_FLAC_METADATA_BLOCKS_TO_SCAN = 64
const MAX_FLAC_METADATA_BYTES_TO_SCAN = 8 * 1024 * 1024
const QUALITY_FFT_SIZE = 4096
const QUALITY_MAX_SPECTRAL_WINDOWS = 24
const DUPLICATE_DURATION_TOLERANCE_SECONDS = 2
const DUPLICATE_STAT_MAX_WORKERS = 4
const DUPLICATE_HASH_MAX_WORKERS = 2

export class IntegrityScanCancelledError extends Error {
  constructor(message = 'Integrity scan canceled') {
    super(message)
    this.name = 'IntegrityScanCancelledError'
  }
}

export function isIntegrityScanCancelledError(error: unknown): error is IntegrityScanCancelledError {
  return error instanceof IntegrityScanCancelledError
}

export function throwIfIntegrityScanCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new IntegrityScanCancelledError()
  }
}

function normalizePathForPrefix(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/\/+$/, '')
}

function normalizeIntegrityTrackPathList(trackPaths: readonly string[]): string[] {
  const normalized: string[] = []
  const seen = new Set<string>()

  for (const trackPath of trackPaths) {
    if (typeof trackPath !== 'string') continue
    const trimmed = trackPath.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }

  return normalized
}

export function filterIntegrityTargetsByScope(
  targets: readonly IntegrityScanTrackTarget[],
  scope: IntegrityScanScope
): IntegrityScanTrackTarget[] {
  if (scope.type === 'all') {
    return [...targets]
  }

  if (scope.type === 'track') {
    return targets.filter((track) => track.path === scope.trackPath)
  }

  if (scope.type === 'tracks') {
    const selectedPaths = normalizeIntegrityTrackPathList(scope.trackPaths)
    if (selectedPaths.length === 0) return []
    const targetByPath = new Map(targets.map((track) => [track.path, track]))
    return selectedPaths
      .map((trackPath) => targetByPath.get(trackPath))
      .filter((track): track is IntegrityScanTrackTarget => Boolean(track))
  }

  const folderPrefix = normalizePathForPrefix(scope.folderPath)
  return targets.filter((track) => {
    const trackPath = normalizePathForPrefix(track.path)
    return trackPath === folderPrefix || trackPath.startsWith(`${folderPrefix}/`)
  })
}

export function isFlacTarget(target: Pick<IntegrityScanTrackTarget, 'format' | 'path'>): boolean {
  const format = target.format.trim().toLowerCase()
  return format === 'flac' || extname(target.path).toLowerCase() === '.flac'
}

export function resolveIntegrityWorkerCount(
  fileCount: number,
  mode: IntegrityScanMode,
  options: { onBattery?: boolean; cpuCount?: number } = {}
): number {
  if (fileCount <= 0) return 1
  if (options.onBattery) return 1

  const cpuCount = options.cpuCount ?? cpus().length
  if (!Number.isFinite(cpuCount) || cpuCount <= 1) return 1

  if (mode === 'deep') {
    if (fileCount < DEEP_SCAN_PARALLEL_MIN_FILES) return 1
    return Math.min(DEEP_SCAN_PARALLEL_MAX_WORKERS, Math.max(1, Math.floor(cpuCount / 3)))
  }

  if (fileCount < QUICK_SCAN_PARALLEL_MIN_FILES) return 1
  return Math.max(
    QUICK_SCAN_PARALLEL_MIN_WORKERS,
    Math.min(QUICK_SCAN_PARALLEL_MAX_WORKERS, Math.floor(cpuCount / 2))
  )
}

export async function runIntegrityWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  if (items.length === 0) return
  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  let nextIndex = 0

  async function runWorker(): Promise<void> {
    while (true) {
      throwIfIntegrityScanCancelled(options.signal)
      const currentIndex = nextIndex
      nextIndex += 1
      if (currentIndex >= items.length) return
      await worker(items[currentIndex], currentIndex)
    }
  }

  const results = await Promise.allSettled(Array.from({ length: workerCount }, () => runWorker()))
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (rejected) {
    throw rejected.reason
  }
}

function normalizeDuplicateText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase()
}

function getDuplicateMetadataKey(candidate: Pick<IntegrityScanTrackTarget, 'title' | 'artist'>): string | null {
  const title = normalizeDuplicateText(candidate.title)
  const artist = normalizeDuplicateText(candidate.artist)
  if (!title || !artist) return null
  return `${title}\u0000${artist}`
}

function buildMetadataDuplicateClusters(
  candidates: readonly IntegrityDuplicateCandidate[]
): number[][] {
  const indicesByMetadata = new Map<string, number[]>()
  candidates.forEach((candidate, index) => {
    const key = getDuplicateMetadataKey(candidate)
    if (!key || !Number.isFinite(candidate.duration) || candidate.duration <= 0) return
    const indices = indicesByMetadata.get(key)
    if (indices) indices.push(index)
    else indicesByMetadata.set(key, [index])
  })

  const clusters: number[][] = []
  for (const indices of indicesByMetadata.values()) {
    const sorted = [...indices].sort((left, right) => (
      candidates[left].duration - candidates[right].duration
      || candidates[left].path.localeCompare(candidates[right].path)
    ))
    let cluster: number[] = []
    let clusterMinimumDuration = 0
    for (const index of sorted) {
      const duration = candidates[index].duration
      if (cluster.length === 0 || duration - clusterMinimumDuration <= DUPLICATE_DURATION_TOLERANCE_SECONDS) {
        if (cluster.length === 0) clusterMinimumDuration = duration
        cluster.push(index)
        continue
      }
      if (cluster.length >= 2) clusters.push(cluster)
      cluster = [index]
      clusterMinimumDuration = duration
    }
    if (cluster.length >= 2) clusters.push(cluster)
  }
  return clusters
}

class DuplicateUnionFind {
  private readonly parent: number[]
  private readonly rank: number[]

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index)
    this.rank = Array.from({ length: size }, () => 0)
  }

  find(index: number): number {
    const parent = this.parent[index]
    if (parent !== index) this.parent[index] = this.find(parent)
    return this.parent[index]
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left)
    const rightRoot = this.find(right)
    if (leftRoot === rightRoot) return
    if (this.rank[leftRoot] < this.rank[rightRoot]) {
      this.parent[leftRoot] = rightRoot
      return
    }
    this.parent[rightRoot] = leftRoot
    if (this.rank[leftRoot] === this.rank[rightRoot]) this.rank[leftRoot] += 1
  }
}

export function buildIntegrityDuplicateGroups(
  candidates: readonly IntegrityDuplicateCandidate[],
  scopedPaths: ReadonlySet<string>,
  runId: string
): IntegrityDuplicateGroup[] {
  if (candidates.length < 2 || scopedPaths.size === 0) return []

  const unionFind = new DuplicateUnionFind(candidates.length)
  const exactSetIdByPath = new Map<string, string>()
  const indicesByHash = new Map<string, number[]>()
  candidates.forEach((candidate, index) => {
    if (!candidate.contentHash) return
    const indices = indicesByHash.get(candidate.contentHash)
    if (indices) indices.push(index)
    else indicesByHash.set(candidate.contentHash, [index])
  })

  let exactSequence = 0
  const exactSets = Array.from(indicesByHash.values())
    .filter((indices) => indices.length >= 2)
    .sort((left, right) => candidates[left[0]].path.localeCompare(candidates[right[0]].path))
  for (const indices of exactSets) {
    exactSequence += 1
    const exactSetId = `${runId}:exact:${exactSequence}`
    const anchor = indices[0]
    for (const index of indices) {
      unionFind.union(anchor, index)
      exactSetIdByPath.set(candidates[index].path, exactSetId)
    }
  }

  for (const cluster of buildMetadataDuplicateClusters(candidates)) {
    const anchor = cluster[0]
    for (const index of cluster.slice(1)) unionFind.union(anchor, index)
  }

  const indicesByRoot = new Map<number, number[]>()
  candidates.forEach((_candidate, index) => {
    const root = unionFind.find(index)
    const indices = indicesByRoot.get(root)
    if (indices) indices.push(index)
    else indicesByRoot.set(root, [index])
  })

  const components = Array.from(indicesByRoot.values())
    .filter((indices) => indices.length >= 2 && indices.some((index) => scopedPaths.has(candidates[index].path)))
    .sort((left, right) => candidates[left[0]].path.localeCompare(candidates[right[0]].path))

  return components.map((indices, groupIndex) => {
    const orderedIndices = [...indices].sort((left, right) => candidates[left].path.localeCompare(candidates[right].path))
    const hashes = new Set(orderedIndices.map((index) => candidates[index].contentHash).filter(Boolean))
    const allExactlyEqual = hashes.size === 1 && orderedIndices.every((index) => Boolean(candidates[index].contentHash))
    const hasExactSubset = orderedIndices.some((index) => exactSetIdByPath.has(candidates[index].path))
    const evidence = allExactlyEqual ? 'exact' : hasExactSubset ? 'mixed' : 'possible'
    const members: IntegrityDuplicateMember[] = orderedIndices.map((index) => {
      const candidate = candidates[index]
      const exactSetId = exactSetIdByPath.get(candidate.path)
      return {
        path: candidate.path,
        title: candidate.title,
        artist: candidate.artist,
        album: candidate.album,
        duration: candidate.duration,
        format: candidate.format,
        sizeBytes: candidate.sizeBytes,
        bitrate: candidate.bitrate,
        sampleRate: candidate.sampleRate,
        bitDepth: candidate.bitDepth,
        channels: candidate.channels,
        withinScope: scopedPaths.has(candidate.path),
        ...(exactSetId ? { exactSetId } : {})
      }
    })
    return {
      id: `${runId}:duplicate:${groupIndex + 1}`,
      evidence,
      members
    }
  })
}

async function hashFileForDuplicateScan(filePath: string, signal?: AbortSignal): Promise<string> {
  throwIfIntegrityScanCancelled(signal)
  const hash = createHash('sha256')
  try {
    const stream = createReadStream(filePath, { signal })
    for await (const chunk of stream) {
      throwIfIntegrityScanCancelled(signal)
      hash.update(chunk as Buffer)
    }
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new IntegrityScanCancelledError()
    }
    throw error
  }
  return hash.digest('hex')
}

function collectScopedMetadataCandidatePaths(
  candidates: readonly IntegrityDuplicateCandidate[],
  scopedPaths: ReadonlySet<string>
): Set<string> {
  const paths = new Set(scopedPaths)
  for (const cluster of buildMetadataDuplicateClusters(candidates)) {
    if (!cluster.some((index) => scopedPaths.has(candidates[index].path))) continue
    for (const index of cluster) paths.add(candidates[index].path)
  }
  return paths
}

export async function scanIntegrityDuplicates(
  allTargets: readonly IntegrityScanTrackTarget[],
  scope: IntegrityScanScope,
  runId: string,
  options: IntegrityDuplicateScanOptions = {}
): Promise<IntegrityDuplicateScanOutput> {
  const findings: IntegrityFindingInput[] = []
  const candidates: IntegrityDuplicateCandidate[] = []
  const scopedPaths = new Set(filterIntegrityTargetsByScope(allTargets, scope).map((target) => target.path))
  let progressCurrent = 0
  let progressTotal = allTargets.length
  let skipped = 0
  const statWorkers = options.onBattery
    ? 1
    : Math.max(1, Math.min(DUPLICATE_STAT_MAX_WORKERS, Math.floor(cpus().length / 2)))

  await runIntegrityWithConcurrency(allTargets, statWorkers, async (target) => {
    try {
      const fileStat = await stat(target.path)
      if (!fileStat.isFile()) {
        skipped += 1
        findings.push(buildFinding(
          target,
          'error',
          'duplicate_not_a_file',
          'Duplicate comparison skipped a path that is not a normal file.'
        ))
        return
      }
      candidates.push({
        ...target,
        sizeBytes: fileStat.size,
        modifiedAtMs: fileStat.mtimeMs
      })
    } catch (error) {
      skipped += 1
      findings.push(buildFinding(
        target,
        'error',
        'duplicate_file_unreadable',
        'Duplicate comparison could not read this file.',
        toErrorMessage(error)
      ))
    } finally {
      progressCurrent += 1
      options.onProgress?.(
        progressCurrent,
        progressTotal,
        target.path,
        'Reading file sizes and timestamps...'
      )
    }
  }, { signal: options.signal })

  throwIfIntegrityScanCancelled(options.signal)
  candidates.sort((left, right) => left.path.localeCompare(right.path))
  const relevantPaths = collectScopedMetadataCandidatePaths(candidates, scopedPaths)
  const candidatesBySize = new Map<number, IntegrityDuplicateCandidate[]>()
  for (const candidate of candidates) {
    const sameSize = candidatesBySize.get(candidate.sizeBytes)
    if (sameSize) sameSize.push(candidate)
    else candidatesBySize.set(candidate.sizeBytes, [candidate])
  }
  const hashTargets = Array.from(candidatesBySize.values())
    .filter((sameSize) => sameSize.length >= 2 && sameSize.some((candidate) => relevantPaths.has(candidate.path)))
    .flat()
  progressTotal += hashTargets.length
  const hashWorkers = options.onBattery ? 1 : DUPLICATE_HASH_MAX_WORKERS

  await runIntegrityWithConcurrency(hashTargets, hashWorkers, async (candidate) => {
    try {
      candidate.contentHash = await hashFileForDuplicateScan(candidate.path, options.signal)
    } catch (error) {
      if (isIntegrityScanCancelledError(error)) throw error
      findings.push(buildFinding(
        candidate,
        'warning',
        'duplicate_hash_failed',
        'Exact duplicate comparison failed for this file.',
        toErrorMessage(error)
      ))
    } finally {
      progressCurrent += 1
      options.onProgress?.(
        progressCurrent,
        progressTotal,
        candidate.path,
        'Hashing same-size duplicate candidates...'
      )
    }
  }, { signal: options.signal })

  const groups = buildIntegrityDuplicateGroups(candidates, scopedPaths, runId)
  const groupedPaths = new Set(groups.flatMap((group) => group.members.map((member) => member.path)))
  const snapshots = new Map<string, IntegrityDuplicateSnapshotMember>()
  for (const candidate of candidates) {
    if (!groupedPaths.has(candidate.path)) continue
    snapshots.set(candidate.path, {
      path: candidate.path,
      title: candidate.title,
      artist: candidate.artist,
      duration: candidate.duration,
      sizeBytes: candidate.sizeBytes,
      modifiedAtMs: candidate.modifiedAtMs
    })
  }

  return {
    groups,
    findings,
    snapshots,
    scanned: candidates.length,
    skipped
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error.trim()
  return 'Unknown error'
}

function buildFinding(
  target: IntegrityScanTrackTarget,
  severity: IntegrityFinding['severity'],
  code: string,
  message: string,
  detail?: string,
  confidence?: IntegrityFinding['confidence']
): IntegrityFindingInput {
  return {
    severity,
    code,
    path: target.path,
    title: target.title,
    message,
    detail,
    confidence
  }
}

function bytesToHex(buffer: Buffer): string {
  return buffer.toString('hex')
}

function readUint24BE(buffer: Buffer, offset: number): number {
  return (buffer[offset] << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2]
}

export function parseFlacStreamInfoBlock(block: Buffer): FlacStreamInfo {
  if (block.length !== FLAC_STREAMINFO_LENGTH) {
    throw new Error(`Invalid FLAC STREAMINFO length: ${block.length}`)
  }

  const minBlockSize = block.readUInt16BE(0)
  const maxBlockSize = block.readUInt16BE(2)
  const minFrameSize = readUint24BE(block, 4)
  const maxFrameSize = readUint24BE(block, 7)
  const sampleRate = (block[10] << 12) | (block[11] << 4) | ((block[12] & 0xf0) >> 4)
  const channels = ((block[12] & 0x0e) >> 1) + 1
  const bitsPerSample = (((block[12] & 0x01) << 4) | ((block[13] & 0xf0) >> 4)) + 1
  const totalSamplesBigInt =
    (BigInt(block[13] & 0x0f) << 32n)
    | (BigInt(block[14]) << 24n)
    | (BigInt(block[15]) << 16n)
    | (BigInt(block[16]) << 8n)
    | BigInt(block[17])
  const totalSamples = Number(totalSamplesBigInt)
  const md5 = bytesToHex(block.subarray(18, 34))

  return {
    minBlockSize,
    maxBlockSize,
    minFrameSize,
    maxFrameSize,
    sampleRate,
    channels,
    bitsPerSample,
    totalSamples,
    md5
  }
}

export async function readFlacStreamInfo(filePath: string): Promise<FlacStreamInfo> {
  const file = await open(filePath, 'r')
  try {
    const magic = Buffer.alloc(4)
    const magicRead = await file.read(magic, 0, magic.length, 0)
    if (magicRead.bytesRead !== magic.length || magic.toString('ascii') !== 'fLaC') {
      throw new Error('FLAC marker not found.')
    }

    let position = 4
    let scannedBytes = 0
    for (let blockIndex = 0; blockIndex < MAX_FLAC_METADATA_BLOCKS_TO_SCAN; blockIndex++) {
      const header = Buffer.alloc(FLAC_METADATA_HEADER_LENGTH)
      const headerRead = await file.read(header, 0, header.length, position)
      if (headerRead.bytesRead !== header.length) {
        throw new Error('Unexpected end of file while reading FLAC metadata.')
      }

      const isLastBlock = Boolean(header[0] & 0x80)
      const blockType = header[0] & 0x7f
      const blockLength = readUint24BE(header, 1)
      position += FLAC_METADATA_HEADER_LENGTH
      scannedBytes += FLAC_METADATA_HEADER_LENGTH + blockLength

      if (blockLength < 0 || scannedBytes > MAX_FLAC_METADATA_BYTES_TO_SCAN) {
        throw new Error('FLAC metadata is too large to inspect safely.')
      }

      if (blockType === 0) {
        const block = Buffer.alloc(blockLength)
        const blockRead = await file.read(block, 0, block.length, position)
        if (blockRead.bytesRead !== block.length) {
          throw new Error('Unexpected end of file while reading FLAC STREAMINFO.')
        }
        return parseFlacStreamInfoBlock(block)
      }

      position += blockLength
      if (isLastBlock) break
    }

    throw new Error('FLAC STREAMINFO block not found.')
  } finally {
    await file.close()
  }
}

function estimateTrackDurationSeconds(
  target: IntegrityScanTrackTarget,
  parsedDuration?: number
): number | null {
  if (typeof parsedDuration === 'number' && Number.isFinite(parsedDuration) && parsedDuration > 0) {
    return parsedDuration
  }
  if (Number.isFinite(target.duration) && target.duration > 0) {
    return target.duration
  }
  return null
}

function getLosslessByteRateFloor(target: IntegrityScanTrackTarget): number {
  const format = target.format.trim().toLowerCase()
  if (format === 'flac' || format === 'alac' || format === 'wav' || format === 'aiff') {
    return 1024
  }
  return 512
}

export async function quickScanIntegrityTrack(
  target: IntegrityScanTrackTarget,
  options: { signal?: AbortSignal } = {}
): Promise<IntegrityFindingInput[]> {
  throwIfIntegrityScanCancelled(options.signal)
  const findings: IntegrityFindingInput[] = []
  let fileStat: Awaited<ReturnType<typeof stat>>

  try {
    fileStat = await stat(target.path)
  } catch (error) {
    return [
      buildFinding(
        target,
        'error',
        'file_unreadable',
        'File could not be opened.',
        toErrorMessage(error)
      )
    ]
  }

  if (!fileStat.isFile()) {
    findings.push(buildFinding(target, 'error', 'not_a_file', 'Path is not a regular file.'))
    return findings
  }

  if (fileStat.size === 0) {
    findings.push(buildFinding(target, 'error', 'empty_file', 'File is empty.'))
    return findings
  }

  let parsedDuration: number | undefined
  try {
    const metadata = await mm.parseFile(
      target.path,
      getMusicMetadataParseOptions(target.path, { skipCovers: true })
    )
    parsedDuration = metadata.format.duration
  } catch (error) {
    findings.push(
      buildFinding(
        target,
        'error',
        'metadata_unreadable',
        'Audio metadata could not be parsed.',
        toErrorMessage(error)
      )
    )
  }

  const durationSeconds = estimateTrackDurationSeconds(target, parsedDuration)
  if (durationSeconds != null && durationSeconds >= 10) {
    const bytesPerSecond = fileStat.size / durationSeconds
    const byteRateFloor = getLosslessByteRateFloor(target)
    if (bytesPerSecond < byteRateFloor) {
      findings.push(
        buildFinding(
          target,
          'warning',
          'implausibly_small_file',
          'File size is unusually small for the claimed duration.',
          `${Math.round(bytesPerSecond)} bytes/s across ${Math.round(durationSeconds)} seconds.`
        )
      )
    }
  }

  if (!isFlacTarget(target)) {
    return findings
  }

  try {
    const streamInfo = await readFlacStreamInfo(target.path)
    if (/^0+$/.test(streamInfo.md5)) {
      findings.push(
        buildFinding(
          target,
          'warning',
          'flac_zero_md5',
          'FLAC STREAMINFO MD5 is zeroed.',
          'The FLAC file omits the decoded-audio checksum, so corruption cannot be verified from STREAMINFO.'
        )
      )
    }
    if (streamInfo.totalSamples === 0) {
      findings.push(
        buildFinding(
          target,
          'warning',
          'flac_zero_total_samples',
          'FLAC STREAMINFO reports zero total samples.',
          'This is valid FLAC, but often indicates a broken encoder or incomplete metadata.'
        )
      )
    }
    if (target.sampleRate && streamInfo.sampleRate > 0 && target.sampleRate !== streamInfo.sampleRate) {
      findings.push(
        buildFinding(
          target,
          'warning',
          'flac_sample_rate_mismatch',
          'Indexed sample rate differs from FLAC STREAMINFO.',
          `Library: ${target.sampleRate} Hz. STREAMINFO: ${streamInfo.sampleRate} Hz.`
        )
      )
    }
    if (target.bitDepth && streamInfo.bitsPerSample > 0 && target.bitDepth !== streamInfo.bitsPerSample) {
      findings.push(
        buildFinding(
          target,
          'warning',
          'flac_bit_depth_mismatch',
          'Indexed bit depth differs from FLAC STREAMINFO.',
          `Library: ${target.bitDepth}-bit. STREAMINFO: ${streamInfo.bitsPerSample}-bit.`
        )
      )
    }
  } catch (error) {
    findings.push(
      buildFinding(
        target,
        'error',
        'flac_streaminfo_unreadable',
        'FLAC STREAMINFO could not be read.',
        toErrorMessage(error)
      )
    )
  }

  return findings
}

function signExtend24(value: number): number {
  return value & 0x800000 ? value | 0xff000000 : value
}

function readPcmSample(buffer: Buffer, offset: number, format: PcmOutputFormat): number {
  if (format === 's16le') {
    return buffer.readInt16LE(offset) / 32768
  }

  const raw = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
  return signExtend24(raw) / 8388608
}

function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length
  let j = 0
  for (let i = 1; i < n; i++) {
    let bit = n >> 1
    while (j & bit) {
      j ^= bit
      bit >>= 1
    }
    j ^= bit
    if (i < j) {
      const tr = real[i]
      real[i] = real[j]
      real[j] = tr
      const ti = imag[i]
      imag[i] = imag[j]
      imag[j] = ti
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wLenR = Math.cos(angle)
    const wLenI = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let wr = 1
      let wi = 0
      for (let k = 0; k < len / 2; k++) {
        const uR = real[i + k]
        const uI = imag[i + k]
        const vR = real[i + k + len / 2] * wr - imag[i + k + len / 2] * wi
        const vI = real[i + k + len / 2] * wi + imag[i + k + len / 2] * wr
        real[i + k] = uR + vR
        imag[i + k] = uI + vI
        real[i + k + len / 2] = uR - vR
        imag[i + k + len / 2] = uI - vI
        const nextWr = wr * wLenR - wi * wLenI
        wi = wr * wLenI + wi * wLenR
        wr = nextWr
      }
    }
  }
}

export class PcmQualityAccumulator {
  private readonly sampleRate: number
  private readonly channels: number
  private readonly sourceBitDepth: number | null
  private readonly window = new Float64Array(QUALITY_FFT_SIZE)
  private windowFill = 0
  private spectralWindowCount = 0
  private skipFrames = 0
  private lowBitSampleCount = 0
  private lowBitNonZeroCount = 0
  private spectralTotalEnergy = 0
  private ultrasonicEnergy = 0
  private presenceEnergy = 0
  private topAudibleEnergy = 0

  constructor(sampleRate: number, channels: number, sourceBitDepth: number | null) {
    this.sampleRate = Math.max(1, Math.round(sampleRate))
    this.channels = Math.max(1, Math.round(channels))
    this.sourceBitDepth = sourceBitDepth && sourceBitDepth > 0 ? Math.round(sourceBitDepth) : null
  }

  ingest(buffer: Buffer, format: PcmOutputFormat): void {
    const bytesPerSample = format === 's24le' ? 3 : 2
    const frameBytes = bytesPerSample * this.channels
    const frameCount = Math.floor(buffer.length / frameBytes)
    const shouldInspectLowBits = format === 's24le' && (this.sourceBitDepth ?? 0) >= 24

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      const frameOffset = frameIndex * frameBytes
      let mono = 0
      for (let channel = 0; channel < this.channels; channel++) {
        const sampleOffset = frameOffset + channel * bytesPerSample
        if (shouldInspectLowBits) {
          this.lowBitSampleCount += 1
          if (buffer[sampleOffset] !== 0) {
            this.lowBitNonZeroCount += 1
          }
        }
        mono += readPcmSample(buffer, sampleOffset, format)
      }
      mono /= this.channels

      if (this.spectralWindowCount >= QUALITY_MAX_SPECTRAL_WINDOWS) continue
      if (this.skipFrames > 0) {
        this.skipFrames -= 1
        continue
      }

      this.window[this.windowFill] = mono
      this.windowFill += 1
      if (this.windowFill >= QUALITY_FFT_SIZE) {
        this.analyzeWindow()
        this.windowFill = 0
        this.skipFrames = Math.max(0, Math.floor(this.sampleRate * 3) - QUALITY_FFT_SIZE)
      }
    }
  }

  getStats(): PcmAnalysisStats {
    return {
      sourceBitDepth: this.sourceBitDepth,
      lowBitSampleCount: this.lowBitSampleCount,
      lowBitNonZeroCount: this.lowBitNonZeroCount,
      spectralWindowCount: this.spectralWindowCount,
      spectralTotalEnergy: this.spectralTotalEnergy,
      ultrasonicEnergy: this.ultrasonicEnergy,
      presenceEnergy: this.presenceEnergy,
      topAudibleEnergy: this.topAudibleEnergy,
      nyquist: this.sampleRate / 2
    }
  }

  private analyzeWindow(): void {
    const real = new Float64Array(QUALITY_FFT_SIZE)
    const imag = new Float64Array(QUALITY_FFT_SIZE)
    for (let index = 0; index < QUALITY_FFT_SIZE; index++) {
      const hann = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (QUALITY_FFT_SIZE - 1)))
      real[index] = this.window[index] * hann
    }

    fft(real, imag)
    this.spectralWindowCount += 1

    const nyquist = this.sampleRate / 2
    const ultrasonicFloor = this.sampleRate >= 96_000 ? 24_000 : 22_050
    const topAudibleUpper = Math.min(20_500, nyquist - 200)

    for (let bin = 1; bin < QUALITY_FFT_SIZE / 2; bin++) {
      const frequency = (bin * this.sampleRate) / QUALITY_FFT_SIZE
      const energy = real[bin] * real[bin] + imag[bin] * imag[bin]
      if (!Number.isFinite(energy) || energy <= 0) continue

      if (frequency >= 20 && frequency <= nyquist - 200) {
        this.spectralTotalEnergy += energy
      }
      if (frequency >= ultrasonicFloor && frequency <= nyquist - 500) {
        this.ultrasonicEnergy += energy
      }
      if (frequency >= 12_000 && frequency <= 16_000) {
        this.presenceEnergy += energy
      }
      if (frequency >= 18_000 && frequency <= topAudibleUpper) {
        this.topAudibleEnergy += energy
      }
    }
  }
}

export function buildQualityFindings(
  target: IntegrityScanTrackTarget,
  stats: PcmAnalysisStats
): IntegrityFindingInput[] {
  const findings: IntegrityFindingInput[] = []

  if ((stats.sourceBitDepth ?? 0) >= 24 && stats.lowBitSampleCount >= 20_000) {
    const nonZeroRatio = stats.lowBitNonZeroCount / stats.lowBitSampleCount
    if (nonZeroRatio <= 0.0005) {
      findings.push(
        buildFinding(
          target,
          'info',
          'quality_padded_bit_depth',
          'Possible 16-bit audio stored as 24-bit FLAC.',
          `Evidence: only ${(nonZeroRatio * 100).toFixed(4)}% of inspected low bytes were non-zero.`,
          'high'
        )
      )
    }
  }

  if (stats.nyquist >= 44_100 && stats.spectralWindowCount >= 3 && stats.spectralTotalEnergy > 0) {
    const ultrasonicRatio = stats.ultrasonicEnergy / stats.spectralTotalEnergy
    if (ultrasonicRatio < 0.0001) {
      findings.push(
        buildFinding(
          target,
          'info',
          'quality_possible_upsample',
          'Possible upsampled high-sample-rate FLAC.',
          `Evidence: energy above the expected CD/48k band was ${(ultrasonicRatio * 100).toFixed(4)}% of measured energy.`,
          ultrasonicRatio < 0.00002 ? 'medium' : 'low'
        )
      )
    }
  }

  if (stats.nyquist >= 20_500 && stats.spectralWindowCount >= 3 && stats.presenceEnergy > 0) {
    const topAudibleRatio = stats.topAudibleEnergy / stats.presenceEnergy
    if (topAudibleRatio < 0.005) {
      findings.push(
        buildFinding(
          target,
          'info',
          'quality_possible_lossy_source',
          'Possible lossy source or low-pass-filtered master.',
          `Evidence: energy from 18-20 kHz was ${(topAudibleRatio * 100).toFixed(3)}% of the 12-16 kHz band.`,
          topAudibleRatio < 0.001 ? 'medium' : 'low'
        )
      )
    }
  }

  return findings
}

function getPcmOutputFormat(streamInfo: FlacStreamInfo, target: IntegrityScanTrackTarget): PcmOutputFormat {
  const bitDepth = streamInfo.bitsPerSample || target.bitDepth || 0
  return bitDepth > 16 ? 's24le' : 's16le'
}

function getPcmCodec(format: PcmOutputFormat): string {
  return format === 's24le' ? 'pcm_s24le' : 'pcm_s16le'
}

async function decodeFlacForIntegrity(
  target: IntegrityScanTrackTarget,
  streamInfo: FlacStreamInfo,
  ffmpegPath: string,
  options: IntegrityWorkerOptions = {}
): Promise<{ decodedFrames: number; stats: PcmAnalysisStats }> {
  throwIfIntegrityScanCancelled(options.signal)
  const pcmFormat = getPcmOutputFormat(streamInfo, target)
  const bytesPerSample = pcmFormat === 's24le' ? 3 : 2
  const channels = streamInfo.channels || target.channels || 2
  const frameBytes = bytesPerSample * channels
  const accumulator = new PcmQualityAccumulator(
    streamInfo.sampleRate || target.sampleRate || 48_000,
    channels,
    streamInfo.bitsPerSample || target.bitDepth
  )

  return await new Promise((resolve, reject) => {
    let decodedFrames = 0
    let remainder = Buffer.alloc(0)
    const stderrChunks: Buffer[] = []
    let settled = false

    const child = spawn(ffmpegPath, [
      '-v', 'error',
      '-i', target.path,
      '-map', '0:a:0',
      '-vn',
      '-sn',
      '-dn',
      '-c:a', getPcmCodec(pcmFormat),
      '-f', pcmFormat,
      'pipe:1'
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const abort = () => {
      if (settled) return
      child.kill('SIGKILL')
      reject(new IntegrityScanCancelledError())
    }

    options.signal?.addEventListener('abort', abort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      if (options.signal?.aborted) return
      const data = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk
      const completeLength = data.length - (data.length % frameBytes)
      if (completeLength > 0) {
        const complete = data.subarray(0, completeLength)
        decodedFrames += completeLength / frameBytes
        accumulator.ingest(complete, pcmFormat)
      }
      remainder = Buffer.from(data.subarray(completeLength))
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(Buffer.from(chunk))
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', abort)
      reject(error)
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', abort)
      if (options.signal?.aborted) {
        reject(new IntegrityScanCancelledError())
        return
      }
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderrChunks).toString('utf8').trim() || `ffmpeg exited with code ${code ?? 'unknown'}`))
        return
      }
      resolve({
        decodedFrames,
        stats: accumulator.getStats()
      })
    })
  })
}

export async function deepScanFlacIntegrityTrack(
  target: IntegrityScanTrackTarget,
  ffmpegPath: string,
  options: IntegrityWorkerOptions = {}
): Promise<IntegrityFindingInput[]> {
  throwIfIntegrityScanCancelled(options.signal)
  const findings = await quickScanIntegrityTrack(target, options)
  const hasStreamInfoError = findings.some((finding) => finding.code === 'flac_streaminfo_unreadable')
  if (hasStreamInfoError) return findings

  let streamInfo: FlacStreamInfo
  try {
    streamInfo = await readFlacStreamInfo(target.path)
  } catch (error) {
    findings.push(
      buildFinding(
        target,
        'error',
        'flac_streaminfo_unreadable',
        'FLAC STREAMINFO could not be read.',
        toErrorMessage(error)
      )
    )
    return findings
  }

  try {
    const decoded = await decodeFlacForIntegrity(target, streamInfo, ffmpegPath, options)
    if (streamInfo.totalSamples > 0 && decoded.decodedFrames !== streamInfo.totalSamples) {
      findings.push(
        buildFinding(
          target,
          'error',
          'flac_sample_count_mismatch',
          'Decoded sample count does not match FLAC STREAMINFO.',
          `STREAMINFO: ${streamInfo.totalSamples} frames. Decoded: ${decoded.decodedFrames} frames.`
        )
      )
    }
    findings.push(...buildQualityFindings(target, decoded.stats))
  } catch (error) {
    if (isIntegrityScanCancelledError(error)) throw error
    findings.push(
      buildFinding(
        target,
        'error',
        'flac_decode_failed',
        'FLAC decode failed during deep scan.',
        toErrorMessage(error)
      )
    )
  }

  return findings
}

export function formatIntegrityScopeLabel(scope: IntegrityScanScope): string {
  if (scope.type === 'all') return 'All Library'
  if (scope.type === 'track') return basename(scope.trackPath)
  if (scope.type === 'tracks') return `${scope.trackPaths.length} Selected Tracks`
  return basename(scope.folderPath) || scope.folderPath
}
