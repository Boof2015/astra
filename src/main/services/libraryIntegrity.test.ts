import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  buildIntegrityDuplicateGroups,
  buildQualityFindings,
  filterIntegrityTargetsByScope,
  IntegrityScanCancelledError,
  parseFlacStreamInfoBlock,
  quickScanIntegrityTrack,
  readFlacStreamInfo,
  resolveIntegrityWorkerCount,
  runIntegrityWithConcurrency,
  scanIntegrityDuplicates,
  type IntegrityDuplicateCandidate,
  type IntegrityScanTrackTarget
} from './libraryIntegrity.ts'

function buildStreamInfoBlock(options: {
  sampleRate: number
  channels: number
  bitsPerSample: number
  totalSamples: number
  md5?: Buffer
}): Buffer {
  const block = Buffer.alloc(34)
  block.writeUInt16BE(4096, 0)
  block.writeUInt16BE(4096, 2)
  block.writeUIntBE(100, 4, 3)
  block.writeUIntBE(200, 7, 3)

  const channelBits = options.channels - 1
  const bitDepthBits = options.bitsPerSample - 1
  const totalSamples = BigInt(options.totalSamples)
  block[10] = (options.sampleRate >> 12) & 0xff
  block[11] = (options.sampleRate >> 4) & 0xff
  block[12] = ((options.sampleRate & 0x0f) << 4) | ((channelBits & 0x07) << 1) | ((bitDepthBits >> 4) & 0x01)
  block[13] = ((bitDepthBits & 0x0f) << 4) | Number((totalSamples >> 32n) & 0x0fn)
  block[14] = Number((totalSamples >> 24n) & 0xffn)
  block[15] = Number((totalSamples >> 16n) & 0xffn)
  block[16] = Number((totalSamples >> 8n) & 0xffn)
  block[17] = Number(totalSamples & 0xffn)
  ;(options.md5 ?? Buffer.alloc(16, 0xab)).copy(block, 18)
  return block
}

function buildNativeFlacFile(streamInfoBlock: Buffer): Buffer {
  const header = Buffer.from([
    0x80,
    0x00,
    0x00,
    streamInfoBlock.length
  ])
  return Buffer.concat([Buffer.from('fLaC', 'ascii'), header, streamInfoBlock])
}

async function withTempDir<T>(callback: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'astra-integrity-'))
  try {
    return await callback(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const targets: IntegrityScanTrackTarget[] = [
  {
    path: '/music/A/one.flac',
    title: 'One',
    artist: 'A',
    album: 'Album',
    duration: 60,
    format: 'flac',
    sampleRate: 44100,
    bitDepth: 16,
    bitrate: null,
    channels: 2
  },
  {
    path: '/music/A/Disc 2/two.mp3',
    title: 'Two',
    artist: 'A',
    album: 'Album',
    duration: 60,
    format: 'mp3',
    sampleRate: 44100,
    bitDepth: null,
    bitrate: 320,
    channels: 2
  },
  {
    path: '/music/B/three.flac',
    title: 'Three',
    artist: 'B',
    album: 'Other',
    duration: 60,
    format: 'flac',
    sampleRate: 96000,
    bitDepth: 24,
    bitrate: null,
    channels: 2
  }
]

function duplicateCandidate(
  path: string,
  title: string,
  artist: string,
  duration: number,
  overrides: Partial<IntegrityDuplicateCandidate> = {}
): IntegrityDuplicateCandidate {
  return {
    path,
    title,
    artist,
    album: 'Album',
    duration,
    format: 'flac',
    sampleRate: 44100,
    bitDepth: 16,
    bitrate: 900,
    channels: 2,
    sizeBytes: 1000,
    modifiedAtMs: 123,
    ...overrides
  }
}

test('parseFlacStreamInfoBlock reads packed STREAMINFO fields', () => {
  const block = buildStreamInfoBlock({
    sampleRate: 96000,
    channels: 2,
    bitsPerSample: 24,
    totalSamples: 12_345_678
  })

  assert.deepEqual(parseFlacStreamInfoBlock(block), {
    minBlockSize: 4096,
    maxBlockSize: 4096,
    minFrameSize: 100,
    maxFrameSize: 200,
    sampleRate: 96000,
    channels: 2,
    bitsPerSample: 24,
    totalSamples: 12_345_678,
    md5: 'abababababababababababababababab'
  })
})

test('parseFlacStreamInfoBlock rejects malformed length', () => {
  assert.throws(() => parseFlacStreamInfoBlock(Buffer.alloc(12)), /Invalid FLAC STREAMINFO length/)
})

test('readFlacStreamInfo reads zero MD5 and zero sample STREAMINFO values', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'zero-streaminfo.flac')
    await writeFile(filePath, buildNativeFlacFile(buildStreamInfoBlock({
      sampleRate: 44100,
      channels: 2,
      bitsPerSample: 16,
      totalSamples: 0,
      md5: Buffer.alloc(16)
    })))

    const streamInfo = await readFlacStreamInfo(filePath)
    assert.equal(streamInfo.totalSamples, 0)
    assert.equal(streamInfo.md5, '00000000000000000000000000000000')
  })
})

test('readFlacStreamInfo rejects malformed metadata payloads', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'broken.flac')
    await writeFile(filePath, Buffer.from([
      ...Buffer.from('fLaC', 'ascii'),
      0x80,
      0x00,
      0x00,
      0x22
    ]))

    await assert.rejects(() => readFlacStreamInfo(filePath), /Unexpected end of file/)
  })
})

test('quickScanIntegrityTrack classifies zero STREAMINFO values as warnings', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'zeroed.flac')
    await writeFile(filePath, buildNativeFlacFile(buildStreamInfoBlock({
      sampleRate: 44100,
      channels: 2,
      bitsPerSample: 16,
      totalSamples: 0,
      md5: Buffer.alloc(16)
    })))

    const findings = await quickScanIntegrityTrack({
      path: filePath,
      title: 'Zeroed',
      artist: 'Test',
      album: 'Test',
      duration: 60,
      format: 'flac',
      sampleRate: 44100,
      bitDepth: 16,
      bitrate: null,
      channels: 2
    })

    assert.equal(findings.some((finding) => finding.code === 'flac_zero_md5' && finding.severity === 'warning'), true)
    assert.equal(findings.some((finding) => finding.code === 'flac_zero_total_samples' && finding.severity === 'warning'), true)
  })
})

test('filterIntegrityTargetsByScope resolves all, folder, and track scopes', () => {
  assert.equal(filterIntegrityTargetsByScope(targets, { type: 'all' }).length, 3)
  assert.deepEqual(
    filterIntegrityTargetsByScope(targets, { type: 'folder', folderPath: '/music/A' }).map((track) => track.path),
    ['/music/A/one.flac', '/music/A/Disc 2/two.mp3']
  )
  assert.deepEqual(
    filterIntegrityTargetsByScope(targets, { type: 'track', trackPath: '/music/B/three.flac' }).map((track) => track.path),
    ['/music/B/three.flac']
  )
  assert.deepEqual(
    filterIntegrityTargetsByScope(targets, {
      type: 'tracks',
      trackPaths: ['/music/B/three.flac', '/music/A/one.flac', '/music/B/three.flac']
    }).map((track) => track.path),
    ['/music/B/three.flac', '/music/A/one.flac']
  )
})

test('duplicate grouping normalizes title and artist while enforcing a two-second duration span', () => {
  const candidates = [
    duplicateCandidate('/music/A.flac', '  Same   Song ', 'The Artist', 100),
    duplicateCandidate('/music/B.mp3', 'same song', 'the artist', 102, { format: 'mp3' }),
    duplicateCandidate('/music/C.flac', 'Same Song', 'The Artist', 102.01),
    duplicateCandidate('/music/D.flac', 'Same Song', 'The Artist', 0)
  ]

  const groups = buildIntegrityDuplicateGroups(candidates, new Set(['/music/A.flac']), 'run')
  assert.equal(groups.length, 1)
  assert.equal(groups[0].evidence, 'possible')
  assert.deepEqual(groups[0].members.map((member) => member.path), ['/music/A.flac', '/music/B.mp3'])
  assert.equal(groups[0].members[1].withinScope, false)
})

test('duplicate grouping marks byte-identical metadata mismatches as exact', () => {
  const candidates = [
    duplicateCandidate('/music/A.flac', 'One', 'Artist A', 100, { contentHash: 'same' }),
    duplicateCandidate('/elsewhere/B.flac', 'Different tags', 'Artist B', 200, { contentHash: 'same' })
  ]

  const groups = buildIntegrityDuplicateGroups(candidates, new Set(['/music/A.flac']), 'run')
  assert.equal(groups.length, 1)
  assert.equal(groups[0].evidence, 'exact')
  assert.equal(groups[0].members.every((member) => Boolean(member.exactSetId)), true)
})

test('duplicate grouping combines exact subsets and cross-format metadata candidates without overlapping groups', () => {
  const candidates = [
    duplicateCandidate('/music/A.flac', 'Song', 'Artist', 100, { contentHash: 'same' }),
    duplicateCandidate('/music/B.flac', 'Song', 'Artist', 100, { contentHash: 'same' }),
    duplicateCandidate('/other/C.mp3', 'Song', 'Artist', 100.5, { format: 'mp3', sizeBytes: 500 }),
    duplicateCandidate('/music/unrelated.flac', 'Other', 'Artist', 100)
  ]

  const groups = buildIntegrityDuplicateGroups(candidates, new Set(['/music/A.flac']), 'run')
  assert.equal(groups.length, 1)
  assert.equal(groups[0].evidence, 'mixed')
  assert.deepEqual(groups[0].members.map((member) => member.path), [
    '/music/A.flac',
    '/music/B.flac',
    '/other/C.mp3'
  ])
})

test('duplicate scan hashes same-size files by streaming and compares a track scope against the whole library', async () => {
  await withTempDir(async (dir) => {
    const firstPath = join(dir, 'first.mp3')
    const secondPath = join(dir, 'nested-copy.flac')
    const bytes = Buffer.from('identical audio payload')
    await writeFile(firstPath, bytes)
    await writeFile(secondPath, bytes)
    const scanTargets: IntegrityScanTrackTarget[] = [
      { ...targets[1], path: firstPath, title: 'First metadata' },
      { ...targets[0], path: secondPath, title: 'Other metadata' }
    ]

    const output = await scanIntegrityDuplicates(
      scanTargets,
      { type: 'track', trackPath: firstPath },
      'run'
    )
    assert.equal(output.groups.length, 1)
    assert.equal(output.groups[0].evidence, 'exact')
    assert.equal(output.groups[0].members.find((member) => member.path === secondPath)?.withinScope, false)
    assert.equal(output.scanned, 2)
    assert.equal(output.skipped, 0)
  })
})

test('duplicate scan records unreadable files and honors cancellation', async () => {
  const missingTarget = { ...targets[0], path: '/definitely-missing/astra-duplicate.flac' }
  const output = await scanIntegrityDuplicates([missingTarget], { type: 'all' }, 'run')
  assert.equal(output.scanned, 0)
  assert.equal(output.skipped, 1)
  assert.equal(output.findings[0]?.code, 'duplicate_file_unreadable')

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    scanIntegrityDuplicates([missingTarget], { type: 'all' }, 'run-canceled', { signal: controller.signal }),
    IntegrityScanCancelledError
  )
})

test('resolveIntegrityWorkerCount keeps deep scans capped and battery-safe', () => {
  assert.equal(resolveIntegrityWorkerCount(500, 'quick', { cpuCount: 8 }), 4)
  assert.equal(resolveIntegrityWorkerCount(500, 'quick', { cpuCount: 8, onBattery: true }), 1)
  assert.equal(resolveIntegrityWorkerCount(50, 'deep', { cpuCount: 12 }), 2)
  assert.equal(resolveIntegrityWorkerCount(50, 'deep', { cpuCount: 12, onBattery: true }), 1)
})

test('runIntegrityWithConcurrency waits for active workers after cancellation', async () => {
  const controller = new AbortController()
  let slowWorkerFinished = false
  let releaseAbort!: () => void
  const slowWorkerStarted = new Promise<void>((resolve) => {
    releaseAbort = resolve
  })

  await assert.rejects(
    runIntegrityWithConcurrency([0, 1], 2, async (item) => {
      if (item === 0) {
        await slowWorkerStarted
        controller.abort()
        throw new IntegrityScanCancelledError()
      }

      releaseAbort()
      await new Promise((resolve) => setTimeout(resolve, 20))
      slowWorkerFinished = true
    }, { signal: controller.signal }),
    IntegrityScanCancelledError
  )

  assert.equal(slowWorkerFinished, true)
})

test('buildQualityFindings reports padded 24-bit and low ultrasonic energy as info', () => {
  const findings = buildQualityFindings(targets[2], {
    sourceBitDepth: 24,
    lowBitSampleCount: 100_000,
    lowBitNonZeroCount: 0,
    spectralWindowCount: 6,
    spectralTotalEnergy: 10_000,
    ultrasonicEnergy: 0.2,
    presenceEnergy: 2_000,
    topAudibleEnergy: 0.5,
    nyquist: 48_000
  })

  assert.equal(findings.every((finding) => finding.severity === 'info'), true)
  assert.equal(findings.some((finding) => finding.code === 'quality_padded_bit_depth' && finding.confidence === 'high'), true)
  assert.equal(findings.some((finding) => finding.code === 'quality_possible_upsample'), true)
  assert.equal(findings.some((finding) => finding.code === 'quality_possible_lossy_source'), true)
})
