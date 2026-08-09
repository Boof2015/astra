#!/usr/bin/env node

const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '../..')
const electron = require('electron')
const result = spawnSync(electron, [
  '--test',
  '--test-concurrency=1',
  'native/test/ffmpeg-pcm-capture.test.mjs'
], {
  cwd: repoRoot,
  env: {
    ...process.env,
    ASTRA_TEST_NODE_EXECUTABLE: process.execPath,
    ELECTRON_RUN_AS_NODE: '1'
  },
  stdio: 'inherit'
})

if (result.error) {
  console.error(`Failed to run native capture tests under Electron: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
