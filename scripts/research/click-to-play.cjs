const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '../..')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
// Match the native addon layout expected by production main/preload bundles.
const nativeLink = path.join(root, '.astra-playback-benchmark/native')
fs.mkdirSync(path.dirname(nativeLink), { recursive: true })
if (!fs.existsSync(nativeLink)) fs.symlinkSync(path.join(root, 'native'), nativeLink, 'dir')

function launch(configPath) {
  const log = fs.openSync(`${configPath}.log`, 'w')
  const result = spawnSync(require('electron'), [path.join(__dirname, 'click-to-play.electron.cjs'), configPath], {
    cwd: root, env, stdio: ['ignore', log, log], timeout: 310000
  })
  fs.closeSync(log)
  if (result.status !== 0) throw new Error(`Benchmark failed (${result.status}): ${configPath}.log ${result.error ?? ''}`)
}

if (process.argv[2] === '--single') {
  launch(process.argv[3])
} else {
  const output = process.argv[3] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'astra-playback-results-'))
  fs.mkdirSync(output, { recursive: true })
  const fixtures = path.join(output, 'fixtures')
  fs.mkdirSync(fixtures, { recursive: true })
  for (const [name, duration, channels, codec] of [
    ['stereo.mp3', 180, 2, 'libmp3lame'], ['stereo.flac', 180, 2, 'flac'],
    ['long.flac', 480, 2, 'flac'], ['surround.flac', 120, 6, 'flac']
  ]) {
    if (fs.existsSync(path.join(fixtures, name))) continue
    const result = spawnSync(require('ffmpeg-static'), [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      `sine=frequency=440:sample_rate=48000:duration=${duration}`, '-ac', String(channels), '-c:a', codec, path.join(fixtures, name)
    ], { stdio: 'inherit' })
    if (result.status) process.exit(result.status)
  }
  const cases = [
    { name: 'controlled-album', size: 12, controlled: true, normalization: 'disabled' },
    { name: 'controlled-50k', size: 50000, controlled: true, normalization: 'disabled' },
    { name: 'flac-uncached', normalization: 'uncached' },
    { name: 'flac-cached', normalization: 'cached' },
    { name: 'flac-disabled', normalization: 'disabled' },
    { name: 'flac-replaygain', normalization: 'replaygain' },
    { name: 'flac-50k-cached', size: 50000, normalization: 'cached' },
    { name: 'mp3-uncached', fixture: 'stereo.mp3', normalization: 'uncached' },
    { name: 'long-uncached', fixture: 'long.flac', duration: 480, normalization: 'uncached' },
    { name: 'surround-uncached', fixture: 'surround.flac', duration: 120, channels: 6, normalization: 'uncached' }
  ].filter((item) => !process.env.ASTRA_PLAY_BENCH_CASE || item.name.includes(process.env.ASTRA_PLAY_BENCH_CASE))
  for (const name of ['stereo.mp3', 'stereo.flac', 'long.flac', 'surround.flac']) {
    fs.copyFileSync(path.join(fixtures, name), path.join(fixtures, `alternate-${name}`))
  }
  for (const build of (process.argv[2] ?? 'before,after').split(',')) {
    for (const item of cases) {
      for (let run = 0; run < 5; run++) {
        const config = {
          size: 12, duration: 180, channels: 2, ...item, build,
          path: path.join(fixtures, item.fixture ?? 'stereo.flac'), warmClicks: run === 0 ? 20 : 0,
          alternatePath: path.join(fixtures, `alternate-${item.fixture ?? 'stereo.flac'}`),
          output: path.join(output, `${build}-${item.name}-${run}.result.json`)
        }
        const configPath = path.join(output, `${build}-${item.name}-${run}.json`)
        fs.writeFileSync(configPath, JSON.stringify(config))
        launch(configPath)
        console.log(`${build} ${item.name} run ${run + 1}/5: ${config.output}`)
      }
    }
  }
}
