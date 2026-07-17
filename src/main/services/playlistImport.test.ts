import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePlaylistDocument } from './playlistImport.ts'

const repeatedPath = '/music/repeated.flac'

const cases = [
  {
    name: 'CSV',
    filePath: 'repeated.csv',
    content: `path\n${repeatedPath}\n${repeatedPath}\n`
  },
  {
    name: 'M3U',
    filePath: 'repeated.m3u',
    content: `#EXTM3U\n${repeatedPath}\n${repeatedPath}\n`
  },
  {
    name: 'M3U8',
    filePath: 'repeated.m3u8',
    content: `#EXTM3U\n${repeatedPath}\n${repeatedPath}\n`
  },
  {
    name: 'XSPF',
    filePath: 'repeated.xspf',
    content: `<playlist><trackList><track><location>${repeatedPath}</location></track><track><location>${repeatedPath}</location></track></trackList></playlist>`
  },
  {
    name: 'WPL',
    filePath: 'repeated.wpl',
    content: `<smil><body><seq><media src="${repeatedPath}"/><media src="${repeatedPath}"/></seq></body></smil>`
  },
  {
    name: 'ASX',
    filePath: 'repeated.asx',
    content: `<asx><entry><ref href="${repeatedPath}"/></entry><entry><ref href="${repeatedPath}"/></entry></asx>`
  }
] as const

for (const playlistCase of cases) {
  test(`${playlistCase.name} parsing preserves repeated entries`, () => {
    const parsed = parsePlaylistDocument(playlistCase.filePath, playlistCase.content)
    assert.deepEqual(parsed.entries.map((entry) => entry.path), [repeatedPath, repeatedPath])
  })
}
