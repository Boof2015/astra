#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const outputPath = path.resolve(__dirname, '../../out/build-metadata.json')
const repoRoot = path.resolve(__dirname, '../..')

const DIRTY_ENV_TRUE_VALUES = new Set(['1', 'true', 'yes', 'dirty'])
const DIRTY_ENV_FALSE_VALUES = new Set(['0', 'false', 'no', 'clean'])

function normalizeCommitHash(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseDirtyEnvValue(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  if (DIRTY_ENV_TRUE_VALUES.has(normalized)) return true
  if (DIRTY_ENV_FALSE_VALUES.has(normalized)) return false
  return null
}

function execGit(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function resolveBuildMetadata() {
  const envCommitHash = normalizeCommitHash(process.env.ASTRA_GIT_COMMIT)
  const envDirty = parseDirtyEnvValue(process.env.ASTRA_GIT_DIRTY)

  if (envCommitHash) {
    return {
      commitHash: envCommitHash,
      isDirty: envDirty ?? false,
    }
  }

  try {
    const commitHash = normalizeCommitHash(execGit(['rev-parse', 'HEAD']))
    if (!commitHash) {
      return {
        commitHash: null,
        isDirty: false,
      }
    }

    const isDirty = envDirty ?? execGit(['status', '--porcelain']).trim().length > 0
    return {
      commitHash,
      isDirty,
    }
  } catch {
    return {
      commitHash: null,
      isDirty: false,
    }
  }
}

const metadata = resolveBuildMetadata()
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
