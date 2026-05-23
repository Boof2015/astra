import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import {
  lookupSidecarLyrics,
  lookupSidecarLrcLyrics,
  resolveSidecarLrcPath,
  resolveSidecarXlrcPath
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
  assert.equal(result.lyrics.format, 'lrc')
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
  assert.equal(result.lyrics.format, 'lrc')
  assert.deepEqual(result.lyrics.syncedLines, [
    { timestampMs: 100, text: 'Fallback line' }
  ])
})

test('finds an XLRC file next to a matching audio filename', async (t) => {
  const temp = await createTempDir()
  t.after(temp.cleanup)

  await writeFile(
    join(temp.dir, 'Track.xlrc'),
    '[00:01.00]<00:01.00>私[わたし]\n[>en]Me',
    'utf-8'
  )

  const result = await lookupSidecarLyrics(join(temp.dir, 'Track.flac'))
  assert.ok(result)
  if (result.status !== 'hit') assert.fail('Expected sidecar lyrics lookup to hit.')
  assert.equal(result.lyrics.source, 'xlrc')
  assert.equal(result.lyrics.format, 'xlrc')
  assert.deepEqual(result.lyrics.syncedLines, [
    {
      timestampMs: 1_000,
      text: '私',
      words: [
        {
          timestampMs: 1_000,
          text: '私',
          furigana: [{ start: 0, end: 1, base: '私', reading: 'わたし' }]
        }
      ],
      furigana: [{ start: 0, end: 1, base: '私', reading: 'わたし' }],
      translations: [{ lang: 'en', text: 'Me' }]
    }
  ])
})

test('prefers XLRC sidecars before LRC sidecars', async (t) => {
  const temp = await createTempDir()
  t.after(temp.cleanup)

  await writeFile(join(temp.dir, 'Track.lrc'), '[00:01.00]LRC line', 'utf-8')
  await writeFile(join(temp.dir, 'Track.xlrc'), '[00:01.00]XLRC line', 'utf-8')

  const result = await lookupSidecarLyrics(join(temp.dir, 'Track.flac'))
  assert.ok(result)
  if (result.status !== 'hit') assert.fail('Expected sidecar lyrics lookup to hit.')
  assert.equal(result.lyrics.source, 'xlrc')
  assert.equal(result.lyrics.plainLyrics, 'XLRC line')
})

test('skips URL-style remote track paths', async () => {
  assert.equal(await resolveSidecarLrcPath('subsonic://1/track/Track.flac'), null)
  assert.equal(await resolveSidecarLrcPath('jellyfin://1/track/Track.flac'), null)
  assert.equal(await resolveSidecarXlrcPath('subsonic://1/track/Track.flac'), null)
})
