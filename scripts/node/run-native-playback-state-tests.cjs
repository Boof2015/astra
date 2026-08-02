#!/usr/bin/env node

const path = require('node:path')
const { spawnSync } = require('node:child_process')

const executable = path.resolve(
  __dirname,
  '../../native/build/Release',
  process.platform === 'win32' ? 'native_playback_state_tests.exe' : 'native_playback_state_tests'
)
const result = spawnSync(executable, [], { stdio: 'inherit' })
if (result.error) {
  console.error(`Failed to run native playback state tests: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
