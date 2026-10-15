import type { ProviderSyncRef } from './providerSync'

export interface RemotePlaylistTrack { path: string; title?: string | null; artist?: string | null; album?: string | null; entryId?: number; remoteEntryId?: string }
export interface RemotePlaylistSnapshot { id: string; name: string; writable: boolean; deletable?: boolean; tracks: RemotePlaylistTrack[] }
export interface RemotePlaylistLink extends ProviderSyncRef { id: string; writable: boolean; deletable?: boolean }
export interface RemotePlaylistLocal extends RemotePlaylistSnapshot { localId: number; ref: ProviderSyncRef }
export type RemotePlaylistEdit =
  | { kind: 'rename'; name: string }
  | { kind: 'delete' }
  | { kind: 'insert'; paths: string[]; position: number | 'end' }
  | { kind: 'remove'; entryId: number }
  | { kind: 'removePath'; path: string }
  | { kind: 'move'; entryIds: number[]; position: number }
  | { kind: 'reorder'; entryIds: number[] }
export interface RemotePlaylistStatus extends ProviderSyncRef { enabled: boolean; busy: boolean; error: string | null }
/** Why a server can't take a new playlist, for choosing a fix: not in use, playlist sync off, or tracks it doesn't have. */
export type RemotePlaylistDestinationReason = 'not-in-use' | 'sync-off' | 'tracks'
export interface RemotePlaylistDestination extends ProviderSyncRef {
  name: string
  reason: string | null
  reasonKind: RemotePlaylistDestinationReason | null
}
export type RemotePlaylistCreateResult = { ok: true; playlistId: number } | { ok: false; error: string; uncertain: boolean }
export interface RemotePlaylistsAPI {
  destinations(trackPaths: string[]): Promise<RemotePlaylistDestination[]>
  create(ref: ProviderSyncRef, name: string, trackPaths: string[]): Promise<RemotePlaylistCreateResult>
  status(): Promise<RemotePlaylistStatus[]>
  setEnabled(ref: ProviderSyncRef, enabled: boolean): Promise<void>
  refresh(ref: ProviderSyncRef): Promise<void>
  onChanged(callback: () => void): () => void
}
