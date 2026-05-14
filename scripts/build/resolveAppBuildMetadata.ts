import { execFileSync } from 'node:child_process'

export interface AppBuildMetadata {
  commitHash: string | null
  isDirty: boolean
}

interface ResolveAppBuildMetadataOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  runGitCommand?: (cwd: string, args: string[]) => string
}

const DIRTY_ENV_TRUE_VALUES = new Set(['1', 'true', 'yes', 'dirty'])
const DIRTY_ENV_FALSE_VALUES = new Set(['0', 'false', 'no', 'clean'])

function normalizeCommitHash(value: string | undefined): string | null {
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseDirtyEnvValue(value: string | undefined): boolean | null {
  if (typeof value !== 'string') return null

  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  if (DIRTY_ENV_TRUE_VALUES.has(normalized)) return true
  if (DIRTY_ENV_FALSE_VALUES.has(normalized)) return false
  return null
}

function execGitCommand(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function resolveGitCommitHash(cwd: string, runGitCommand: (cwd: string, args: string[]) => string): string | null {
  try {
    return normalizeCommitHash(runGitCommand(cwd, ['rev-parse', 'HEAD']))
  } catch {
    return null
  }
}

function resolveGitDirtyState(cwd: string, runGitCommand: (cwd: string, args: string[]) => string): boolean {
  try {
    return runGitCommand(cwd, ['status', '--porcelain']).trim().length > 0
  } catch {
    return false
  }
}

export function resolveAppBuildMetadata(options: ResolveAppBuildMetadataOptions = {}): AppBuildMetadata {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const runGitCommand = options.runGitCommand ?? execGitCommand

  const envCommitHash = normalizeCommitHash(env.ASTRA_GIT_COMMIT)
  const envDirtyState = parseDirtyEnvValue(env.ASTRA_GIT_DIRTY)

  if (envCommitHash) {
    return {
      commitHash: envCommitHash,
      isDirty: envDirtyState ?? false,
    }
  }

  const commitHash = resolveGitCommitHash(cwd, runGitCommand)
  if (!commitHash) {
    return {
      commitHash: null,
      isDirty: false,
    }
  }

  return {
    commitHash,
    isDirty: envDirtyState ?? resolveGitDirtyState(cwd, runGitCommand),
  }
}
