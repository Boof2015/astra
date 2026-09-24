/** The collection or explicit track selection that authored a queue item. */
export type PlaybackSourceContext =
  | { type: 'playlist'; playlistId: number }
  | { type: 'artist'; artist: string }
  | { type: 'genre'; genre: string }
  | { type: 'album'; album: string; albumArtist?: string; identityKey?: string }
  | { type: 'track'; trackPath: string }
  | { type: 'year'; year: number | 'unknown' }
