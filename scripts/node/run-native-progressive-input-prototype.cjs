#!/usr/bin/env node

const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// Headless checks of the real DSP/engine; builds fresh without replacing the addon.
const root = path.resolve(__dirname, '../..')
const directory = mkdtempSync(path.join(tmpdir(), 'astra-native-progressive-'))
const executable = path.join(directory, process.platform === 'win32' ? 'probe.exe' : 'probe')
const compiler = process.env.CXX || (process.platform === 'win32' ? 'clang++' : 'c++')
const sanitizer = process.argv.includes('--sanitize')
const threadSanitizer = process.argv.includes('--thread-sanitize')
const engine = process.argv.includes('--engine')
const args = [
  '-std=c++17', '-O2', '-fno-fast-math', '-pthread',
  ...(sanitizer ? ['-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer'] : []),
  ...(threadSanitizer ? ['-g', '-fsanitize=thread'] : []),
  'native/src/playback_engine.cpp', 'native/src/audio_processing.cpp', 'native/src/progressive_playback.cpp',
  ...(engine ? ['native/test/playback_engine_state_test.cpp', 'native/test/endpoint_frame_queue_test.cpp']
    : ['native/prototype/progressive_pcm_input_test.cpp']),
  '-I', 'native/src', '-I', 'third_party/r8brain-free-src', '-o', executable
]

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal || result.status})`)
}

try {
  if (sanitizer && threadSanitizer) throw new Error('Run address/undefined and thread sanitizers separately.')
  run(compiler, args)
  run(executable, [])
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  rmSync(directory, { recursive: true, force: true })
}
