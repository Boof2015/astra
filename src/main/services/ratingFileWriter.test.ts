import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import test from 'node:test'
import { parseFile, updateFile } from 'music-metadata'
import { writeRatingToFile } from './ratingFileWriter.ts'
import { extractRatingTag } from '../utils/ratingTags.ts'

const require = createRequire(import.meta.url)
const ffmpeg: string = require('ffmpeg-static')
const execute = promisify(execFile)
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf000000050001a29903a60000000049454e44ae426082', 'hex')

async function fixture(t: test.TestContext, extension: string, id3 = '4'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'astra-rating-write-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, `track.${extension}`)
  await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '0.1',
    '-metadata', 'title=Keep title', '-metadata', 'artist=Keep artist', '-metadata', 'REPLAYGAIN_TRACK_GAIN=-3 dB',
    '-metadata', 'CUSTOM_FIELD=Keep custom', ...(extension === 'mp3' ? ['-id3v2_version', id3] : []), path], { windowsHide: true })
  return path
}

async function audioDigest(path: string): Promise<string> {
  const result = await execute(ffmpeg, ['-v', 'error', '-i', path, '-map', '0:a:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'], { windowsHide: true })
  return result.stdout.trim()
}

for (const extension of ['mp3', 'flac', 'ogg', 'opus', 'm4a']) {
  test(`rating writes round-trip half-stars and preserve other metadata and audio: ${extension}`, async t => {
    const path = await fixture(t, extension)
    await updateFile(path, {
      picture: [{ format: 'image/png', data: png, type: 'Cover (front)' }],
      lyrics: 'Keep these lyrics'
    })
    if (extension === 'mp3') await updateFile(path, { native: { POPM: [
      { email: 'first', rating: 64, counter: 999 }, { email: 'other', rating: 128, counter: 789 }
    ] } })
    const before = await parseFile(path)
    const digest = await audioDigest(path)
    for (const rating of [0.5, 3, 4.5, 5, null]) {
      await writeRatingToFile(path, rating, () => true)
      const after = await parseFile(path)
      assert.equal(extractRatingTag(after), rating)
      assert.equal(after.common.title, before.common.title)
      assert.equal(after.common.artist, before.common.artist)
      assert.deepEqual(after.common.picture, before.common.picture)
      assert.deepEqual(after.common.lyrics, before.common.lyrics)
      assert.deepEqual(after.common.replaygain_track_gain, before.common.replaygain_track_gain)
      const custom = (value: typeof after) => Object.values(value.native).flat().filter(tag => /CUSTOM_FIELD/.test(tag.id))
      assert.deepEqual(custom(after), custom(before))
      assert.equal(await audioDigest(path), digest)
      if (extension === 'mp3') {
        const popms = after.native['ID3v2.4'].filter(tag => tag.id === 'POPM').map(tag => tag.value as { email: string; counter: number; rating: number })
        assert.equal(popms[0].counter, 999)
        assert.deepEqual(popms[1], { email: 'other', counter: 789, rating: 128 })
      }
    }
  })
}

test('older ID3, disabled permission, read-only and unsupported files remain byte-identical', async t => {
  const old = await fixture(t, 'mp3', '3')
  const original = await readFile(old)
  await assert.rejects(writeRatingToFile(old, 5, () => true), /ID3v2.2\/2.3/)
  assert.deepEqual(await readFile(old), original)
  const path = await fixture(t, 'flac')
  const bytes = await readFile(path)
  await assert.rejects(writeRatingToFile(path, 5, () => false), /disabled|superseded/)
  const mode = (await stat(path)).mode
  await chmod(path, 0o444)
  try { await assert.rejects(writeRatingToFile(path, 5, () => true), /not writable/) }
  finally { await chmod(path, mode) }
  assert.deepEqual(await readFile(path), bytes)
  const unsupported = await fixture(t, 'wav')
  await assert.rejects(writeRatingToFile(unsupported, 5, () => true), /not supported/)
})

test('queued rating writes serialize and a revoked permission prevents final replacement', async t => {
  const path = await fixture(t, 'flac')
  await Promise.all([writeRatingToFile(path, 1, () => true), writeRatingToFile(path, 5, () => true)])
  assert.equal(extractRatingTag(await parseFile(path)), 5)
  const original = await readFile(path)
  let checks = 0
  await assert.rejects(writeRatingToFile(path, 3, () => ++checks === 1), /disabled|superseded/)
  assert.deepEqual(await readFile(path), original)
})

test('external modification during a write is detected without replacing the newer file', async t => {
  const path = await fixture(t, 'flac')
  // A staging directory appears before asynchronous parsing/writing. Change the
  // original then, while leaving the staged source unchanged.
  const operation = writeRatingToFile(path, 3, () => true)
  const directory = join(path, '..')
  for (let i = 0; i < 1000; i++) {
    if ((await readdir(directory)).some(name => name.startsWith('.astra-rating-'))) break
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  const modified = Buffer.concat([await readFile(path), Buffer.from('external edit')])
  await writeFile(path, modified)
  await assert.rejects(operation, /changed during/)
  assert.deepEqual(await readFile(path), modified)
})
