import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const EXPECTED_OPERATIONS: Record<string, readonly string[]> = {
  '/v2/openapi.json': ['get'],
  '/v2/capabilities': ['get'],
  '/v2/playback': ['get'],
  '/v2/playback/actions': ['post'],
  '/v2/events': ['get'],
  '/v2/search': ['get'],
  '/v2/intents': ['post'],
  '/v2/queue': ['get', 'delete'],
  '/v2/queue/items/{id}': ['patch', 'delete'],
  '/v2/artwork/{ref}': ['get'],
  '/v2/tracks/{ref}/favorite': ['put'],
  '/v2/playlists': ['post'],
  '/v2/playlists/{ref}': ['patch'],
  '/v2/playlists/{ref}/items': ['post'],
  '/v2/playlists/{ref}/items/{trackRef}': ['patch', 'delete']
}

async function readContract(): Promise<Record<string, unknown>> {
  const source = await readFile(
    new URL('../../../docs/api/openapi-v2.json', import.meta.url),
    'utf8'
  )
  return JSON.parse(source) as Record<string, unknown>
}

test('OpenAPI 3.1 documents every registered v2 route and method', async () => {
  const document = await readContract()
  assert.equal(document.openapi, '3.1.0')
  const paths = document.paths as Record<string, Record<string, unknown>>
  assert.deepEqual(Object.keys(paths).sort(), Object.keys(EXPECTED_OPERATIONS).sort())

  for (const [path, expectedMethods] of Object.entries(EXPECTED_OPERATIONS)) {
    const actualMethods = Object.keys(paths[path])
      .filter((key) => ['get', 'post', 'put', 'patch', 'delete'].includes(key))
      .sort()
    assert.deepEqual(actualMethods, [...expectedMethods].sort(), path)
  }
})

test('OpenAPI keeps only the contract route public and declares bearer authentication globally', async () => {
  const document = await readContract()
  assert.deepEqual(document.security, [{ bearerAuth: [] }])
  const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>
  assert.deepEqual(paths['/v2/openapi.json'].get.security, [])
  for (const [path, pathItem] of Object.entries(paths)) {
    if (path === '/v2/openapi.json') continue
    for (const operation of Object.values(pathItem)) {
      if (operation && typeof operation === 'object' && 'operationId' in operation) {
        assert.notDeepEqual(operation.security, [], path)
      }
    }
  }
})

test('OpenAPI has no catalog, streaming, settings, DSP, lyrics, or playlist-delete route', async () => {
  const document = await readContract()
  const paths = document.paths as Record<string, Record<string, unknown>>
  assert.equal(paths['/v2/library'], undefined)
  assert.equal(paths['/v2/audio'], undefined)
  assert.equal(paths['/v2/settings'], undefined)
  assert.equal(paths['/v2/lyrics'], undefined)
  assert.equal(paths['/v2/playlists/{ref}'].delete, undefined)
})
