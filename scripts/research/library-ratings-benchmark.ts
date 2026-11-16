// Run with Electron's Node runtime and scripts/node/electron-test-loader.mjs.
// Compare the same count/rounds on each revision; the first round warms caches.
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import * as library from '../../src/main/services/library.ts'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const option = (name: string, fallback: string) => args[args.indexOf(name) + 1] && args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const count = Number(option('--count', '1000'))
const rounds = Number(option('--rounds', '6'))
if (!Number.isInteger(count) || count < 5 || !Number.isInteger(rounds) || rounds < 2) throw new Error('Invalid benchmark size')
const root = await mkdtemp(join(tmpdir(), 'astra-rating-benchmark-'))
const music = join(root, 'music')
const formats = ['mp3', 'flac', 'ogg', 'opus', 'm4a']
const runs: Array<Record<string, { ms: number; parsed: number; skipped: number }>> = []
try {
  await mkdir(music)
  for (const format of formats) {
    await promisify(execFile)(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '0.1',
      '-metadata', 'title=Benchmark', '-metadata', 'artist=Benchmark', '-metadata', 'album=Benchmark',
      '-metadata', 'RATING=80', '-metadata', 'FMPS_RATING=0.8', join(root, `seed.${format}`)], { windowsHide: true })
  }
  for (let i = 0; i < count; i++) {
    const format = formats[i % formats.length]
    await copyFile(join(root, `seed.${format}`), join(music, `${i}.${format}`))
  }
  for (let round = 0; round < rounds; round++) {
    process.env.ASTRA_TEST_USER_DATA = join(root, `db-${round}`)
    await library.initDatabase()
    library.setReplayGainScanEnabled(false)
    // Works on the pre-feature revision too, so the baseline uses the same harness.
    const preferences = (library as unknown as { setRatingPreferences?: (value: unknown) => Promise<unknown> }).setRatingPreferences
    if (preferences) await preferences({ enabled: !args.includes('--disabled'), writeToFiles: false })
    const run: typeof runs[number] = {}
    for (const scenario of ['initial', 'unchanged', 'oneChanged', 'force']) {
      const track = join(music, '0.mp3')
      const original = await stat(track)
      if (scenario === 'oneChanged') await utimes(track, original.atime, new Date(Date.now() + 1000))
      const start = performance.now()
      const result = await library.scanFolder(music, undefined, { diagnostics: true, mode: scenario === 'force' ? 'force' : 'incremental' })
      run[scenario] = { ms: performance.now() - start, parsed: result.diagnostics.metadataParsedFileCount, skipped: result.diagnostics.skippedKnownFileCount }
      if (scenario === 'oneChanged') await utimes(track, original.atime, original.mtime)
    }
    library.closeDatabase()
    runs.push(run)
    console.log(JSON.stringify({ round, ...run }))
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const summary = Object.fromEntries(Object.keys(runs[0]).map(key => [key, median(runs.slice(1).map(run => run[key].ms))]))
  const result = { metadataVersion: JSON.parse(await readFile(new URL('../package.json', import.meta.resolve('music-metadata')), 'utf8')).version, count, rounds, summary, runs }
  console.log(JSON.stringify(result, null, 2))
  if (args.includes('--output')) await writeFile(resolve(option('--output', '')), JSON.stringify(result, null, 2))
} finally {
  library.closeDatabase()
  delete process.env.ASTRA_TEST_USER_DATA
  // root is the absolute directory returned by mkdtemp above, never a caller path.
  await rm(root, { recursive: true, force: true })
}
