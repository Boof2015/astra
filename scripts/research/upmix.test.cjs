const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const ffmpegPath = require('ffmpeg-static')

const script = path.resolve(__dirname, 'upmix.cjs')

test('research harness creates a blinded, targeted quad audition pack', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-upmix-test-'))
  const input = path.join(directory, 'fixture.wav')
  const output = path.join(directory, 'pack')
  try {
    const generate = spawnSync(ffmpegPath, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', 'aevalsrc=0.12*sin(2*PI*311*t)+0.08*sin(2*PI*733*t)|0.12*sin(2*PI*311*t)+0.07*sin(2*PI*997*t):s=48000:d=1',
      '-c:a', 'pcm_f32le', input,
    ], { encoding: 'utf8' })
    assert.equal(generate.status, 0, generate.stderr)

    const render = spawnSync(process.execPath, [
      script, input,
      '--layout', 'quad',
      '--rear-target-db', '-9',
      '--segment', '0.1-0.5',
      '--blind-pack',
      '--output-dir', output,
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    assert.equal(render.status, 0, render.stderr)

    const answerKey = JSON.parse(fs.readFileSync(path.join(output, 'answer-key.json'), 'utf8'))
    assert.deepEqual(new Set(Object.values(answerKey)), new Set([
      'fixed-difference',
      'dominant-matrix',
      'weighted-pca',
      'geometric-decomposition',
      'rejected-adaptive-control',
    ]))
    for (const label of ['A', 'B', 'C', 'D', 'E']) {
      assert.ok(fs.statSync(path.join(output, `${label}-quad.wav`)).size > 44)
      assert.ok(fs.statSync(path.join(output, `${label}-rears.wav`)).size > 44)
      const diagnostics = JSON.parse(
        fs.readFileSync(path.join(output, `${label}-diagnostics.json`), 'utf8')
      )
      assert.equal(diagnostics.algorithm, undefined)
      assert.equal(diagnostics.label, label)
      assert.equal(diagnostics.inputFrames, 19200)
      assert.ok(Number.isFinite(diagnostics.integratedLufs))
      assert.ok(Number.isFinite(diagnostics.truePeakDbfs))
      assert.ok(Math.abs(diagnostics.rearFrontRatioDb + 9) <= 0.25 || diagnostics.rearGainLimited)
      if (answerKey[label] !== 'rejected-adaptive-control') {
        assert.ok(diagnostics.frontNullErrorDb < -100)
      }
    }
    assert.match(fs.readFileSync(path.join(output, 'score-sheet.md'), 'utf8'), /Authored-mix feel/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('research harness creates a blind A/C rear-level sweep', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-upmix-sweep-test-'))
  const input = path.join(directory, 'fixture.wav')
  const output = path.join(directory, 'sweep')
  try {
    const generate = spawnSync(ffmpegPath, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', 'aevalsrc=0.12*sin(2*PI*311*t)+0.08*sin(2*PI*733*t)|0.12*sin(2*PI*311*t)+0.07*sin(2*PI*997*t):s=48000:d=0.4',
      '-c:a', 'pcm_f32le', input,
    ], { encoding: 'utf8' })
    assert.equal(generate.status, 0, generate.stderr)

    const render = spawnSync(process.execPath, [
      script, input,
      '--layout', 'quad',
      '--segment', '0.1-0.2',
      '--blind-level-sweep',
      '--output-dir', output,
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    assert.equal(render.status, 0, render.stderr)

    const answerKey = JSON.parse(fs.readFileSync(path.join(output, 'answer-key.json'), 'utf8'))
    const combinations = new Set(Object.values(answerKey).map((candidate) =>
      `${candidate.previousLabel}:${candidate.algorithm}:${candidate.rearTargetDb}`))
    assert.deepEqual(combinations, new Set([
      'A:dominant-matrix:-12',
      'A:dominant-matrix:-9',
      'A:dominant-matrix:-6',
      'C:geometric-decomposition:-12',
      'C:geometric-decomposition:-9',
      'C:geometric-decomposition:-6',
    ]))
    for (const label of ['A', 'B', 'C', 'D', 'E', 'F']) {
      assert.ok(fs.statSync(path.join(output, `${label}-quad.wav`)).size > 44)
      assert.ok(fs.statSync(path.join(output, `${label}-rears.wav`)).size > 44)
      const candidate = answerKey[label]
      assert.ok(Math.abs(candidate.diagnostics.rearFrontRatioDb - candidate.rearTargetDb) <= 0.25 ||
        candidate.diagnostics.rearGainLimited)
    }
    assert.match(fs.readFileSync(path.join(output, 'score-sheet.md'), 'utf8'), /Rear balance/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('research harness creates a blind center-detail sweep with a pure A control', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-upmix-center-test-'))
  const input = path.join(directory, 'fixture.wav')
  const output = path.join(directory, 'sweep')
  try {
    const generate = spawnSync(ffmpegPath, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', 'aevalsrc=0.12*sin(2*PI*311*t)+0.08*sin(2*PI*733*t)|0.12*sin(2*PI*311*t)+0.07*sin(2*PI*997*t):s=48000:d=0.4',
      '-c:a', 'pcm_f32le', input,
    ], { encoding: 'utf8' })
    assert.equal(generate.status, 0, generate.stderr)

    const render = spawnSync(process.execPath, [
      script, input,
      '--layout', 'quad',
      '--segment', '0.1-0.2',
      '--blind-center-sweep',
      '--output-dir', output,
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    assert.equal(render.status, 0, render.stderr)

    const answerKey = JSON.parse(fs.readFileSync(path.join(output, 'answer-key.json'), 'utf8'))
    assert.deepEqual(new Set(Object.values(answerKey).map((candidate) =>
      candidate.rearCenterDb ?? 'control')), new Set(['control', -24, -21, -18]))
    for (const label of ['A', 'B', 'C', 'D']) {
      assert.ok(fs.statSync(path.join(output, `${label}-quad.wav`)).size > 44)
      assert.ok(fs.statSync(path.join(output, `${label}-rears.wav`)).size > 44)
      assert.equal(answerKey[label].diagnostics.rearCenterDb, answerKey[label].rearCenterDb)
      assert.ok(answerKey[label].diagnostics.frontNullErrorDb < -100)
    }
    assert.match(fs.readFileSync(path.join(output, 'score-sheet.md'), 'utf8'), /Useful extra detail/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
