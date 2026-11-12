import type { JellyfinSource, JellyfinSourceStatus } from './subsonic'

/** Public source metadata only; account and server credentials stay in main. */
export interface PlexSource extends JellyfinSource {
  account_id: string
  server_id: string
  library_id: string
  library_name: string
}
export interface PlexServerChoice { id: string; name: string; owned: boolean }
export interface PlexLibraryChoice { id: string; name: string }
export interface PlexSignInStatus {
  id: string
  state: 'waiting' | 'ready'
  expiresAt: number
  username?: string
  /** Which Plex account signed in, to tell its servers from another account's. */
  accountId?: string
  servers?: PlexServerChoice[]
}
export interface PlexStatusSnapshot { isSyncing: boolean; sources: JellyfinSourceStatus[]; updatedAt: number }
/**
 * Connect libraries of one server from a sign-in. `name` is the server's name (each library
 * is saved as "<name> · <library>"). With `sourceIds`, it reconnects those libraries instead,
 * keeping their names; `libraryIds` must then be exactly theirs.
 */
export interface PlexConnectInput { signInId: string; serverId: string; libraryIds: string[]; name?: string; sourceIds?: number[] }

export interface PlexAPI {
  beginSignIn(): Promise<PlexSignInStatus>
  pollSignIn(id: string): Promise<PlexSignInStatus>
  cancelSignIn(id: string): Promise<void>
  libraries(signInId: string, serverId: string): Promise<PlexLibraryChoice[]>
  connect(input: PlexConnectInput): Promise<PlexSource[]>
  /** The music libraries on a connected library's server, through its stored sign-in. */
  serverLibraries(sourceId: number): Promise<PlexLibraryChoice[]>
  /** Add more libraries of a connected library's server, through its stored sign-in. */
  addLibraries(sourceId: number, libraryIds: string[]): Promise<PlexSource[]>
  listSources(): Promise<PlexSource[]>
  updateSource(id: number, input: { name?: string; enabled?: boolean }): Promise<PlexSource>
  deleteSource(id: number, purgeTracks: boolean): Promise<void>
  syncSource(id: number, syncSessionKey?: string): Promise<void>
  syncAll(syncSessionKey?: string): Promise<void>
  getStatus(): Promise<PlexStatusSnapshot>
  onStatus(callback: (status: PlexStatusSnapshot) => void): () => void
}
