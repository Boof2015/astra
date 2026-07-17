#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '../..')
const testRoots = ['src', 'scripts', 'receiver/src']
const electronTestFiles = new Set([
  'src/main/services/library.test.ts'
])

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/')
}

function findTestFiles(dir) {
  const files = []

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...findTestFiles(entryPath))
      continue
    }

    if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(toPosixPath(path.relative(repoRoot, entryPath)))
    }
  }

  return files
}

function resolveTestFiles() {
  return testRoots
    .map((root) => path.join(repoRoot, root))
    .filter((root) => fs.existsSync(root))
    .flatMap(findTestFiles)
    .sort()
}

function run(label, command, args, env = {}) {
  if (args.length === 0) return 0

  console.log(`[test] ${label}`)
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env
    },
    stdio: 'inherit'
  })

  if (result.error) {
    console.error(`[test] ${label} failed to start: ${result.error.message}`)
    return 1
  }

  return result.status ?? 1
}

function runNodeTests(files) {
  if (files.length === 0) {
    console.log('[test] No Node test files found.')
    return 0
  }

  // --experimental-default-type was removed in Node 23+ (module syntax
  // detection is the default there).
  const nodeMajor = Number(process.versions.node.split('.')[0])
  return run('Node tests', process.execPath, [
    '--experimental-strip-types',
    ...(nodeMajor >= 23 ? [] : ['--experimental-default-type=module']),
    '--loader',
    './scripts/node/electron-test-loader.mjs',
    '--test',
    '--test-concurrency=1',
    ...files
  ])
}

function runElectronTests(files) {
  if (files.length === 0) {
    console.log('[test] No Electron test files found.')
    return 0
  }

  const electron = require('electron')
  return run('Electron tests', electron, [
    '--experimental-strip-types',
    '--loader',
    './scripts/node/electron-test-loader.mjs',
    '--test',
    '--test-concurrency=1',
    ...files
  ], {
    ELECTRON_RUN_AS_NODE: '1'
  })
}

function main() {
  const mode = process.argv[2] || 'all'
  const files = resolveTestFiles()
  const electronFiles = files.filter((file) => electronTestFiles.has(file))
  const nodeFiles = files.filter((file) => !electronTestFiles.has(file))

  if (mode === '--node') {
    process.exit(runNodeTests(nodeFiles))
  }

  if (mode === '--electron') {
    process.exit(runElectronTests(electronFiles))
  }

  if (mode !== 'all') {
    console.error(`[test] Unknown mode: ${mode}`)
    process.exit(1)
  }

  const nodeStatus = runNodeTests(nodeFiles)
  if (nodeStatus !== 0) process.exit(nodeStatus)

  process.exit(runElectronTests(electronFiles))
}

main()
