import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAppBuildMetadata } from './resolveAppBuildMetadata.ts'

test('env overrides win without querying git', () => {
  const gitCalls: string[] = []
  const buildMetadata = resolveAppBuildMetadata({
    cwd: '/tmp/astra',
    env: {
      ASTRA_GIT_COMMIT: 'deadbeefcafebabe1234567890abcdef12345678',
      ASTRA_GIT_DIRTY: 'true',
    },
    runGitCommand: (cwd, args) => {
      gitCalls.push(`${cwd}:${args.join(' ')}`)
      return ''
    },
  })

  assert.deepEqual(buildMetadata, {
    commitHash: 'deadbeefcafebabe1234567890abcdef12345678',
    isDirty: true,
  })
  assert.equal(gitCalls.length, 0)
})

test('clean git checkout resolves commit metadata', () => {
  const buildMetadata = resolveAppBuildMetadata({
    cwd: '/tmp/astra',
    env: {},
    runGitCommand: (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return '0123456789abcdef0123456789abcdef01234567\n'
      }
      if (args[0] === 'status') {
        return ''
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    },
  })

  assert.deepEqual(buildMetadata, {
    commitHash: '0123456789abcdef0123456789abcdef01234567',
    isDirty: false,
  })
})

test('dirty git checkout marks the build as dirty', () => {
  const buildMetadata = resolveAppBuildMetadata({
    cwd: '/tmp/astra',
    env: {},
    runGitCommand: (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return '89abcdef0123456789abcdef0123456789abcdef\n'
      }
      if (args[0] === 'status') {
        return ' M src/main/index.ts\n'
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    },
  })

  assert.deepEqual(buildMetadata, {
    commitHash: '89abcdef0123456789abcdef0123456789abcdef',
    isDirty: true,
  })
})

test('missing git metadata falls back to version-only mode', () => {
  const buildMetadata = resolveAppBuildMetadata({
    cwd: '/tmp/astra',
    env: {},
    runGitCommand: () => {
      throw new Error('git unavailable')
    },
  })

  assert.deepEqual(buildMetadata, {
    commitHash: null,
    isDirty: false,
  })
})
