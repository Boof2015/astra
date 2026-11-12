/**
 * Plex libraries are stored one per row as "<server> · <library>". A server's name in
 * Astra is a library's stored name without that ending; a name typed without it is kept.
 */
export function plexServerName(source: { name: string; library_name: string }): string {
  const ending = ` · ${source.library_name}`
  return source.name.endsWith(ending) && source.name.length > ending.length ? source.name.slice(0, -ending.length) : source.name
}

/** How a library of a server is stored. */
export function plexLibraryEntryName(serverName: string, libraryName: string): string {
  return `${serverName} · ${libraryName}`
}
