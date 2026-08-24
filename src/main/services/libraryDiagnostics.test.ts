import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  LibraryDiagnosticsService,
  type LibraryDiagnosticsLogRecord
} from './libraryDiagnostics.ts'

async function createTempDir(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'astra-library-diagnostics-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function readRecords(path: string): Promise<LibraryDiagnosticsLogRecord[]> {
  const content = await readFile(path, 'utf8')
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LibraryDiagnosticsLogRecord)
}

test('library diagnostics writes ordered crash-readable JSONL and redacts paths', async (t) => {
  const userDataPath = await createTempDir(t)
  const service = new LibraryDiagnosticsService({
    userDataPath,
    getSessionDetails: () => ({ platform: 'win32', rootKindCounts: { drive: 1 } })
  })
  t.after(() => service.shutdown())

  await service.initialize(false)
  assert.equal(service.getStatus().enabled, false)
  await service.setEnabled(true)
  await service.logEvent('scan_folder_finished', {
    fileCount: 12,
    folderPath: 'C:\\Users\\Tester\\Music',
    folderName: 'Private Music',
    nested: {
      trackPath: 'C:\\Users\\Tester\\Music\\secret.flac',
      message: '/Users/tester/Music/secret.flac',
      relative: 'Music\\another-secret.flac'
    }
  }, 'run-1')
  service.logCheckpointSync('folder_removal_checkpoint', { deletedCount: 5 }, 'run-1')
  await service.shutdown()

  const records = await readRecords(service.getStatus().currentLogPath)
  assert.deepEqual(records.map((record) => record.event), [
    'session_started',
    'scan_folder_finished',
    'folder_removal_checkpoint'
  ])
  assert.equal(records[1].runId, 'run-1')
  assert.equal(records[1].details?.fileCount, 12)
  const serialized = JSON.stringify(records)
  assert.equal(serialized.includes('Tester'), false)
  assert.equal(serialized.includes('secret.flac'), false)
  assert.equal(serialized.includes('folderPath'), false)
  assert.equal(serialized.includes('trackPath'), false)
  assert.equal(serialized.includes('Private Music'), false)
  assert.equal(serialized.includes('another-secret.flac'), false)
})

test('library diagnostics rotates the prior session to the previous log', async (t) => {
  const userDataPath = await createTempDir(t)
  const first = new LibraryDiagnosticsService({
    userDataPath,
    getSessionDetails: () => ({ appVersion: 'first' })
  })
  await first.initialize(true)
  await first.logEvent('first_session_marker')
  await first.shutdown()

  const second = new LibraryDiagnosticsService({
    userDataPath,
    getSessionDetails: () => ({ appVersion: 'second' })
  })
  t.after(() => second.shutdown())
  await second.initialize(true)
  await second.shutdown()

  const previous = await readRecords(second.getStatus().previousLogPath)
  const current = await readRecords(second.getStatus().currentLogPath)
  assert.equal(previous.some((record) => record.event === 'first_session_marker'), true)
  assert.equal(current[0]?.event, 'session_started')
  assert.equal(current[0]?.details?.appVersion, 'second')
  assert.equal(second.getStatus().hasPreviousLog, true)
})

test('library diagnostics preserves correlated terminal records for every outcome', async (t) => {
  const userDataPath = await createTempDir(t)
  const service = new LibraryDiagnosticsService({
    userDataPath,
    getSessionDetails: () => ({})
  })
  t.after(() => service.shutdown())
  await service.initialize(true)

  for (const outcome of ['succeeded', 'canceled', 'failed'] as const) {
    const runId = `run-${outcome}`
    await service.logEvent('library_operation_started', { operationKind: 'rescan_all' }, runId, { flush: true })
    await service.logEvent('library_operation_finished', { operationKind: 'rescan_all', outcome }, runId)
  }
  await service.shutdown()

  const operationRecords = (await readRecords(service.getStatus().currentLogPath))
    .filter((record) => record.event.startsWith('library_operation_'))
  assert.deepEqual(operationRecords.map((record) => [record.runId, record.event]), [
    ['run-succeeded', 'library_operation_started'],
    ['run-succeeded', 'library_operation_finished'],
    ['run-canceled', 'library_operation_started'],
    ['run-canceled', 'library_operation_finished'],
    ['run-failed', 'library_operation_started'],
    ['run-failed', 'library_operation_finished']
  ])
  assert.deepEqual(
    operationRecords.filter((record) => record.event === 'library_operation_finished')
      .map((record) => record.details?.outcome),
    ['succeeded', 'canceled', 'failed']
  )
})

test('library diagnostics filesystem failures never escape to callers', async (t) => {
  const userDataPath = await createTempDir(t)
  await mkdir(userDataPath, { recursive: true })
  await writeFile(join(userDataPath, 'logs'), 'blocks diagnostics directory creation', 'utf8')

  const service = new LibraryDiagnosticsService({
    userDataPath,
    getSessionDetails: () => ({})
  })
  await assert.doesNotReject(() => service.initialize(true))
  assert.equal(service.getStatus().enabled, false)
  assert.equal(await service.logEvent('ignored'), false)
  assert.equal(service.logCheckpointSync('ignored'), false)
})
