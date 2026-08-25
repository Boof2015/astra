#!/usr/bin/env node

const path = require('node:path')
const { spawnSync } = require('node:child_process')

const executable = path.resolve(
  __dirname,
  '../../native/build/Release',
  process.platform === 'win32' ? 'track_waveform_tests.exe' : 'track_waveform_tests'
)
const nativeResult = spawnSync(executable, [], { stdio: 'inherit' })
if (nativeResult.error) {
  console.error(`Failed to run static track waveform tests: ${nativeResult.error.message}`)
  process.exit(1)
}
if ((nativeResult.status ?? 1) !== 0) process.exit(nativeResult.status ?? 1)

const parityResult = spawnSync(process.execPath, [
  '--experimental-strip-types',
  '--loader',
  './scripts/node/resolve-ts-loader.mjs',
  '--test',
  'native/test/track-waveform.test.mjs',
], {
  cwd: path.resolve(__dirname, '../..'),
  stdio: 'inherit',
})
if (parityResult.error) {
  console.error(`Failed to run static track waveform parity tests: ${parityResult.error.message}`)
  process.exit(1)
}
process.exit(parityResult.status ?? 1)
