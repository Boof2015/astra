#!/usr/bin/env node

const { spawnSync } = require('node:child_process')
const { randomInt } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

const root = path.resolve(__dirname, '..', '..')
const validLayouts = new Set(['quad', '5.0', '5.1', '7.1'])
const validAlgorithms = new Set([
  'adaptive',
  'rejected-adaptive-control',
  'fixed-difference',
  'dominant-matrix',
  'coherence-mask',
  'weighted-pca',
  'panning-model',
  'geometric-decomposition',
])
const blindAlgorithms = [
  'fixed-difference',
  'dominant-matrix',
  'weighted-pca',
  'geometric-decomposition',
  'rejected-adaptive-control',
]
const levelSweepFinalists = [
  { previousLabel: 'A', algorithm: 'dominant-matrix' },
  { previousLabel: 'C', algorithm: 'geometric-decomposition' },
]
const levelSweepTargetsDb = [-12, -9, -6]
const centerDetailSweepDb = [null, -24, -21, -18]

function fail(message) {
  process.stderr.write(`research:upmix: ${message}\n`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) fail(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) fail(result.error.message)
  if (result.status !== 0) fail(result.stderr.trim() || `${command} failed`)
  return result.stdout
}

function parseTime(value) {
  const parts = String(value).trim().split(':').map(Number)
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    fail(`invalid segment time ${value}`)
  }
  return parts.reduce((seconds, part) => seconds * 60 + part, 0)
}

function parseSegment(value) {
  const separator = String(value).indexOf('-')
  if (separator < 0) fail('segment must use start-end, for example 1:10-1:40')
  const startText = value.slice(0, separator).trim()
  const endText = value.slice(separator + 1).trim()
  const start = parseTime(startText)
  const end = parseTime(endText)
  if (end <= start) fail('segment end must be later than its start')
  return { start, end, duration: end - start, label: `${startText}-${endText}` }
}

function parseArguments(argv) {
  const options = {
    layout: '5.1',
    algorithm: 'adaptive',
    outputDir: null,
    input: null,
    rearTargetDb: null,
    rearCenterDb: null,
    segment: null,
    blindPack: false,
    blindLevelSweep: false,
    blindCenterSweep: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--layout') options.layout = argv[++index]
    else if (argument === '--algorithm') options.algorithm = argv[++index]
    else if (argument === '--output-dir') options.outputDir = argv[++index]
    else if (argument === '--rear-target-db') options.rearTargetDb = Number(argv[++index])
    else if (argument === '--rear-center-db') options.rearCenterDb = Number(argv[++index])
    else if (argument === '--segment') options.segment = parseSegment(argv[++index])
    else if (argument === '--blind-pack') options.blindPack = true
    else if (argument === '--blind-level-sweep') options.blindLevelSweep = true
    else if (argument === '--blind-center-sweep') options.blindCenterSweep = true
    else if (argument === '--help' || argument === '-h') {
      process.stdout.write(
        'Usage: npm run research:upmix -- <audio> [--layout quad|5.0|5.1|7.1] ' +
        '[--algorithm adaptive|rejected-adaptive-control|fixed-difference|dominant-matrix|coherence-mask|' +
        'weighted-pca|panning-model|geometric-decomposition] [--rear-target-db -9] ' +
        '[--rear-center-db -21] [--segment 1:10-1:40] ' +
        '[--blind-pack|--blind-level-sweep|--blind-center-sweep] [--output-dir path]\n'
      )
      process.exit(0)
    } else if (argument.startsWith('-')) fail(`unknown option ${argument}`)
    else if (!options.input) options.input = argument
    else fail(`unexpected argument ${argument}`)
  }
  if (!options.input) fail('an input audio file is required (use --help for usage)')
  if (!validLayouts.has(options.layout)) fail(`unsupported layout ${options.layout}`)
  if (!validAlgorithms.has(options.algorithm)) fail(`unsupported algorithm ${options.algorithm}`)
  if (options.rearTargetDb !== null &&
      (!Number.isFinite(options.rearTargetDb) || options.rearTargetDb < -60 || options.rearTargetDb > 6)) {
    fail('rear target must be between -60 and +6 dB')
  }
  if (options.rearCenterDb !== null &&
      (!Number.isFinite(options.rearCenterDb) || options.rearCenterDb < -60 || options.rearCenterDb > 0)) {
    fail('rear center detail must be between -60 and 0 dB')
  }
  const blindModeCount = [options.blindPack, options.blindLevelSweep, options.blindCenterSweep]
    .filter(Boolean).length
  if (blindModeCount > 1) {
    fail('--blind-pack, --blind-level-sweep, and --blind-center-sweep are mutually exclusive')
  }
  if (blindModeCount > 0 && options.layout !== 'quad') {
    fail('blind packs currently target the quad listening gate')
  }
  if (options.blindLevelSweep && options.rearTargetDb !== null) {
    fail('--blind-level-sweep supplies its own -12, -9, and -6 dB rear targets')
  }
  if (options.blindCenterSweep &&
      (options.rearTargetDb !== null || options.rearCenterDb !== null)) {
    fail('--blind-center-sweep supplies its own production rear level and center-detail gains')
  }
  options.input = path.resolve(options.input)
  if (!fs.existsSync(options.input)) fail(`input does not exist: ${options.input}`)
  const stem = path.basename(options.input, path.extname(options.input))
  const suffix = options.blindPack
    ? 'blind-pack'
    : options.blindLevelSweep
      ? 'blind-level-sweep'
      : options.blindCenterSweep ? 'blind-center-sweep' : `${options.algorithm}-${options.layout}`
  options.outputDir = path.resolve(options.outputDir || `${stem}-${suffix}`)
  if (options.blindPack && options.rearTargetDb === null) options.rearTargetDb = -9
  return options
}

function compileCli() {
  const executable = path.join(
    os.tmpdir(),
    `astra-adaptive-upmix-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`
  )
  const sources = [
    path.join(root, 'native', 'src', 'dsp_utils.cpp'),
    path.join(root, 'native', 'src', 'adaptive_upmixer.cpp'),
    path.join(root, 'native', 'src', 'adaptive_upmix_cli.cpp'),
  ]
  const executableTime = fs.existsSync(executable) ? fs.statSync(executable).mtimeMs : 0
  if (sources.every((source) => fs.statSync(source).mtimeMs <= executableTime)) return executable
  if (process.platform === 'win32') {
    const nodeGypExecutable = path.join(root, 'native', 'build', 'Release', 'adaptive_upmix_cli.exe')
    if (fs.existsSync(nodeGypExecutable)) return nodeGypExecutable
    fail('build native/adaptive_upmix_cli with node-gyp before using the research harness on Windows')
  }
  run(process.env.CXX || 'c++', [
    '-std=c++17', '-O3', '-fno-fast-math',
    ...sources,
    '-I', path.join(root, 'native', 'src'),
    '-o', executable,
  ])
  return executable
}

function wrapRaw(rawPath, outputPath, sampleRate, channels, channelLayout) {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'f32le', '-ar', String(sampleRate), '-ac', String(channels),
  ]
  if (channelLayout) args.push('-channel_layout', channelLayout)
  args.push('-i', rawPath, '-c:a', 'pcm_f32le', outputPath)
  run(ffmpegPath, args)
}

function measureLoudness(audioPath) {
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-nostats', '-i', audioPath,
    '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-',
  ], { encoding: 'utf8' })
  if (result.error || result.status !== 0) return { integratedLufs: null, truePeakDbfs: null }
  const text = `${result.stdout || ''}\n${result.stderr || ''}`
  const loudness = [...text.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s+LUFS/g)].at(-1)
  const peak = [...text.matchAll(/Peak:\s*(-?\d+(?:\.\d+)?)\s+dBFS/g)].at(-1)
  return {
    integratedLufs: loudness ? Number(loudness[1]) : null,
    truePeakDbfs: peak ? Number(peak[1]) : null,
  }
}

function renderSingle(options, outputDir, algorithm = options.algorithm) {
  const probe = JSON.parse(capture(ffprobePath, [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate', '-of', 'json', options.input,
  ]))
  const sampleRate = Number(probe.streams?.[0]?.sample_rate)
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    fail('could not determine a supported sample rate from the first audio stream')
  }

  fs.mkdirSync(outputDir, { recursive: true })
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-upmix-'))
  const paths = {
    input: path.join(temporaryDirectory, 'input.f32'),
    rendered: path.join(temporaryDirectory, 'rendered.f32'),
    primary: path.join(temporaryDirectory, 'primary.f32'),
    ambient: path.join(temporaryDirectory, 'ambient.f32'),
    foldDown: path.join(temporaryDirectory, 'fold-down.f32'),
    diagnostics: path.join(outputDir, 'diagnostics.json'),
  }

  try {
    const decodeArguments = [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', options.input,
    ]
    if (options.segment) {
      decodeArguments.push('-ss', String(options.segment.start), '-t', String(options.segment.duration))
    }
    decodeArguments.push(
      '-map', '0:a:0', '-vn', '-ac', '2', '-ar', String(sampleRate),
      '-f', 'f32le', paths.input,
    )
    run(ffmpegPath, decodeArguments)

    const cliArguments = [
      '--input', paths.input,
      '--output', paths.rendered,
      '--primary', paths.primary,
      '--ambient', paths.ambient,
      '--fold-down', paths.foldDown,
      '--diagnostics', paths.diagnostics,
      '--sample-rate', String(sampleRate),
      '--layout', options.layout,
      '--algorithm', algorithm,
    ]
    if (options.rearTargetDb !== null) {
      cliArguments.push('--rear-target-db', String(options.rearTargetDb))
    }
    if (options.rearCenterDb !== null) {
      cliArguments.push('--rear-center-db', String(options.rearCenterDb))
    }
    run(compileCli(), cliArguments)

    const channelCounts = { quad: 4, '5.0': 5, '5.1': 6, '7.1': 8 }
    const ffmpegLayouts = { quad: 'quad', '5.0': '5.0(side)', '5.1': '5.1(side)', '7.1': '7.1' }
    const renderedWav = path.join(outputDir, 'rendered.wav')
    wrapRaw(paths.rendered, renderedWav, sampleRate,
      channelCounts[options.layout], ffmpegLayouts[options.layout])
    wrapRaw(paths.primary, path.join(outputDir, 'primary.wav'), sampleRate, 2, 'stereo')
    wrapRaw(paths.ambient, path.join(outputDir, 'ambient.wav'), sampleRate, 2, 'stereo')
    wrapRaw(paths.foldDown, path.join(outputDir, 'fold-down.wav'), sampleRate, 2, 'stereo')
    if (options.layout === 'quad') {
      run(ffmpegPath, [
        '-y', '-hide_banner', '-loglevel', 'error', '-i', renderedWav,
        '-filter_complex', 'pan=stereo|c0=c2|c1=c3',
        '-c:a', 'pcm_f32le', path.join(outputDir, 'rear-only.wav'),
      ])
    }

    const diagnostics = JSON.parse(fs.readFileSync(paths.diagnostics, 'utf8'))
    Object.assign(diagnostics, measureLoudness(renderedWav))
    if (options.segment) diagnostics.segment = options.segment.label
    fs.writeFileSync(paths.diagnostics, `${JSON.stringify(diagnostics, null, 2)}\n`)
    process.stdout.write(`Research artifacts written to ${outputDir}\n`)
    return diagnostics
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

function shuffle(values) {
  const result = values.slice()
  for (let index = result.length - 1; index > 0; index -= 1) {
    const replacement = randomInt(index + 1)
    ;[result[index], result[replacement]] = [result[replacement], result[index]]
  }
  return result
}

function buildBlindPack(options) {
  fs.mkdirSync(options.outputDir, { recursive: true })
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-upmix-blind-'))
  const randomized = shuffle(blindAlgorithms)
  const manifest = []
  const answerKey = {}
  try {
    randomized.forEach((algorithm, index) => {
      const label = String.fromCharCode('A'.charCodeAt(0) + index)
      const candidateDirectory = path.join(workDirectory, label)
      const diagnostics = renderSingle(options, candidateDirectory, algorithm)
      fs.copyFileSync(path.join(candidateDirectory, 'rendered.wav'),
        path.join(options.outputDir, `${label}-quad.wav`))
      fs.copyFileSync(path.join(candidateDirectory, 'rear-only.wav'),
        path.join(options.outputDir, `${label}-rears.wav`))
      const blindDiagnostics = { ...diagnostics, algorithm: undefined, label }
      delete blindDiagnostics.algorithm
      fs.writeFileSync(path.join(options.outputDir, `${label}-diagnostics.json`),
        `${JSON.stringify(blindDiagnostics, null, 2)}\n`)
      manifest.push({
        label,
        quad: `${label}-quad.wav`,
        rears: `${label}-rears.wav`,
        diagnostics: `${label}-diagnostics.json`,
      })
      answerKey[label] = algorithm
    })

    fs.writeFileSync(path.join(options.outputDir, 'manifest.json'), `${JSON.stringify({
      source: options.input,
      layout: options.layout,
      rearTargetDb: options.rearTargetDb,
      segment: options.segment?.label ?? 'full track',
      candidates: manifest,
    }, null, 2)}\n`)
    fs.writeFileSync(path.join(options.outputDir, 'answer-key.json'),
      `${JSON.stringify(answerKey, null, 2)}\n`)
    fs.writeFileSync(path.join(options.outputDir, 'score-sheet.md'), `# Adaptive upmixer blind audition\n\n` +
      `Listen to the \`*-quad.wav\` files with the normal front volume. Use the matching ` +
      `\`*-rears.wav\` only to identify leakage or artifacts, not to rank spaciousness. ` +
      `Do not open \`answer-key.json\` until scoring is complete.\n\n` +
      `| Label | Vocals stay in front (1-5) | Rears audible with fronts (1-5) | ` +
      `Front stable (1-5) | No pumping/brightness (1-5) | Authored-mix feel (1-5) | Notes |\n` +
      `|---|---:|---:|---:|---:|---:|---|\n` +
      manifest.map(({ label }) => `| ${label} |  |  |  |  |  |  |`).join('\n') + `\n`)
    fs.writeFileSync(path.join(options.outputDir, 'README.md'), `# Astra upmix audition pack\n\n` +
      `These are full-track 32-bit float quad WAV files in FL, FR, SL, SR order. ` +
      `All rear feeds target ${options.rearTargetDb} dB relative to the rendered front bed. ` +
      `The four research candidates keep FL/FR transparent; one hidden file is the rejected pre-selection ` +
      `Adaptive control. Play the quad files through Astra as discrete multichannel sources with ` +
      `Stereo Upmix set to Off.\n\nComplete \`score-sheet.md\` before opening \`answer-key.json\`.\n`)
    process.stdout.write(`Blind audition pack written to ${options.outputDir}\n`)
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true })
  }
}

function buildBlindLevelSweep(options) {
  fs.mkdirSync(options.outputDir, { recursive: true })
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-upmix-level-sweep-'))
  const randomized = shuffle(levelSweepFinalists.flatMap((finalist) =>
    levelSweepTargetsDb.map((rearTargetDb) => ({ ...finalist, rearTargetDb }))))
  const manifest = []
  const answerKey = {}
  try {
    randomized.forEach((candidate, index) => {
      const label = String.fromCharCode('A'.charCodeAt(0) + index)
      const candidateDirectory = path.join(workDirectory, label)
      const candidateOptions = { ...options, rearTargetDb: candidate.rearTargetDb }
      const diagnostics = renderSingle(candidateOptions, candidateDirectory, candidate.algorithm)
      fs.copyFileSync(path.join(candidateDirectory, 'rendered.wav'),
        path.join(options.outputDir, `${label}-quad.wav`))
      fs.copyFileSync(path.join(candidateDirectory, 'rear-only.wav'),
        path.join(options.outputDir, `${label}-rears.wav`))
      manifest.push({
        label,
        quad: `${label}-quad.wav`,
        rears: `${label}-rears.wav`,
      })
      answerKey[label] = {
        previousLabel: candidate.previousLabel,
        algorithm: candidate.algorithm,
        rearTargetDb: candidate.rearTargetDb,
        diagnostics,
      }
    })

    fs.writeFileSync(path.join(options.outputDir, 'manifest.json'), `${JSON.stringify({
      source: options.input,
      layout: options.layout,
      segment: options.segment?.label ?? 'full track',
      candidates: manifest,
    }, null, 2)}\n`)
    fs.writeFileSync(path.join(options.outputDir, 'answer-key.json'),
      `${JSON.stringify(answerKey, null, 2)}\n`)
    fs.writeFileSync(path.join(options.outputDir, 'score-sheet.md'), `# A/C blind level sweep\n\n` +
      `These are the previous A and C extractors, each rendered at three hidden rear levels. ` +
      `Keep the front volume fixed and score the quad files before opening ` +
      `\`answer-key.json\`.\n\n` +
      `| Label | Vocals stay in front (1-5) | Rear balance (too low/right/too high) | ` +
      `Front stable (1-5) | No pumping/brightness (1-5) | Authored-mix feel (1-5) | Notes |\n` +
      `|---|---:|---|---:|---:|---:|---|\n` +
      manifest.map(({ label }) => `| ${label} |  |  |  |  |  |  |`).join('\n') + `\n`)
    fs.writeFileSync(path.join(options.outputDir, 'README.md'), `# Astra A/C level sweep\n\n` +
      `These full-track 32-bit float quad WAVs compare the previous A (dominant matrix) ` +
      `and C (geometric decomposition) extractors at hidden -12, -9, and -6 dB rear/front ` +
      `targets. Channels are FL, FR, SL, SR. Play them through Astra as discrete ` +
      `multichannel sources with Stereo Upmix set to Off. Keep the physical front level ` +
      `unchanged between files. Use the matching \`*-rears.wav\` files only after the ` +
      `normal-volume comparison to inspect leakage.\n\nComplete \`score-sheet.md\` before ` +
      `opening \`answer-key.json\`.\n`)
    process.stdout.write(`Blind A/C level sweep written to ${options.outputDir}\n`)
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true })
  }
}

function buildBlindCenterSweep(options) {
  fs.mkdirSync(options.outputDir, { recursive: true })
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-upmix-center-sweep-'))
  const randomized = shuffle(centerDetailSweepDb)
  const manifest = []
  const answerKey = {}
  try {
    randomized.forEach((rearCenterDb, index) => {
      const label = String.fromCharCode('A'.charCodeAt(0) + index)
      const candidateDirectory = path.join(workDirectory, label)
      const candidateOptions = { ...options, rearCenterDb }
      const diagnostics = renderSingle(candidateOptions, candidateDirectory, 'adaptive')
      fs.copyFileSync(path.join(candidateDirectory, 'rendered.wav'),
        path.join(options.outputDir, `${label}-quad.wav`))
      fs.copyFileSync(path.join(candidateDirectory, 'rear-only.wav'),
        path.join(options.outputDir, `${label}-rears.wav`))
      manifest.push({
        label,
        quad: `${label}-quad.wav`,
        rears: `${label}-rears.wav`,
      })
      answerKey[label] = {
        rearCenterDb,
        description: rearCenterDb === null ? 'pure production A control' : 'decorrelated center detail',
        diagnostics,
      }
    })

    fs.writeFileSync(path.join(options.outputDir, 'manifest.json'), `${JSON.stringify({
      source: options.input,
      layout: options.layout,
      segment: options.segment?.label ?? 'full track',
      candidates: manifest,
    }, null, 2)}\n`)
    fs.writeFileSync(path.join(options.outputDir, 'answer-key.json'),
      `${JSON.stringify(answerKey, null, 2)}\n`)
    fs.writeFileSync(path.join(options.outputDir, 'score-sheet.md'), `# Adaptive center-detail blind sweep\n\n` +
      `One file is pure production A. The other three keep A's wide rear bed unchanged and add ` +
      `a hidden, band-limited, independently decorrelated center-detail level. Keep the front ` +
      `volume fixed and score before opening \`answer-key.json\`.\n\n` +
      `| Label | Width retained (1-5) | Useful extra detail (1-5) | ` +
      `Vocals stay in front (1-5) | Rear balance (low/right/high) | ` +
      `No pumping/brightness (1-5) | Overall preference | Notes |\n` +
      `|---|---:|---:|---:|---|---:|---:|---|\n` +
      manifest.map(({ label }) => `| ${label} |  |  |  |  |  |  |  |`).join('\n') + `\n`)
    fs.writeFileSync(path.join(options.outputDir, 'README.md'), `# Astra center-detail sweep\n\n` +
      `These full-track 32-bit float Quad WAVs compare pure production A with -24, -21, ` +
      `and -18 dB common-mode detail injection under randomized labels. The added detail is ` +
      `filtered approximately 300 Hz-7 kHz and independently decorrelated into SL/SR. ` +
      `The approved dominant-matrix bed and FL/FR are unchanged. Play as discrete Quad with ` +
      `Stereo Upmix set to Off. Use the rear-only files only after normal-volume scoring.\n\n` +
      `Complete \`score-sheet.md\` before opening \`answer-key.json\`.\n`)
    process.stdout.write(`Blind center-detail sweep written to ${options.outputDir}\n`)
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true })
  }
}

const options = parseArguments(process.argv.slice(2))
if (options.blindPack) buildBlindPack(options)
else if (options.blindLevelSweep) buildBlindLevelSweep(options)
else if (options.blindCenterSweep) buildBlindCenterSweep(options)
else renderSingle(options, options.outputDir)
