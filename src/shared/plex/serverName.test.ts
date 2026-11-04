import assert from 'node:assert/strict'
import test from 'node:test'
import { plexLibraryEntryName, plexServerName } from './serverName.ts'

test('a Plex server is named after its libraries’ stored name, without the library', () => {
  assert.equal(plexServerName({ name: 'Lander’s Plex · Music', library_name: 'Music' }), 'Lander’s Plex')
  assert.equal(plexServerName({ name: 'Home music', library_name: 'Music' }), 'Home music', 'a name typed without the ending is kept')
  assert.equal(plexServerName({ name: ' · Music', library_name: 'Music' }), ' · Music', 'never empty')
  assert.equal(plexLibraryEntryName('Den', 'Audiobooks'), 'Den · Audiobooks')
})
