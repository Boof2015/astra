import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import {
  lookupSidecarLrcLyrics,
  resolveSidecarLrcPath
} from './lyricsSidecar.ts'

async function createTempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'astra-lyrics-sidecar-'))
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

test('finds an LRC file next to a matching audio filename', async (t) => {
  const temp = await createTempDir()
  t.after(temp.cleanup)

  await writeFile(
    join(temp.dir, 'Track.lrc'),
    '[00:01.25]First line\n[00:02.500]Second line',
    'utf-8'
  )

  const result = await lookupSidecarLrcLyrics(join(temp.dir, 'Track.flac'))
  assert.ok(result)
  if (result.status !== 'hit') assert.fail('Expected sidecar lyrics lookup to hit.')
  assert.equal(result.cached, false)
  assert.equal(result.lyrics.source, 'lrc')
  assert.equal(result.lyrics.provider, null)
  assert.equal(result.lyrics.plainLyrics, 'First line\nSecond line')
  assert.equal(result.lyrics.syncedLyrics, '[00:01.25]First line\n[00:02.500]Second line')
  assert.deepEqual(result.lyrics.syncedLines, [
    { timestampMs: 1_250, text: 'First line' },
    { timestampMs: 2_500, text: 'Second line' }
  ])
})

test('falls through when the sidecar LRC file is missing or empty', async (t) => {
  const temp = await createTempDir()
  t.after(temp.cleanup)

  assert.equal(await lookupSidecarLrcLyrics(join(temp.dir, 'Missing.flac')), null)

  await writeFile(join(temp.dir, 'Empty.lrc'), '\n', 'utf-8')
  assert.equal(await lookupSidecarLrcLyrics(join(temp.dir, 'Empty.flac')), null)
})

test('handles extension-case fallback for matching LRC files', async (t) => {
  const temp = await createTempDir()
  t.after(temp.cleanup)

  await writeFile(join(temp.dir, 'Track.LRC'), '[00:00.1]Fallback line', 'utf-8')

  const result = await lookupSidecarLrcLyrics(join(temp.dir, 'Track.flac'))
  assert.ok(result)
  if (result.status !== 'hit') assert.fail('Expected extension-case sidecar lookup to hit.')
  assert.equal(result.lyrics.source, 'lrc')
  assert.deepEqual(result.lyrics.syncedLines, [
    { timestampMs: 100, text: 'Fallback line' }
  ])
})

test('skips URL-style remote track paths', async () => {
  assert.equal(await resolveSidecarLrcPath('subsonic://1/track/Track.flac'), null)
  assert.equal(await resolveSidecarLrcPath('jellyfin://1/track/Track.flac'), null)
})
