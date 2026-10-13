import type { ProviderSyncRef } from './providerSync'

export interface RemotePlaylistTrack { path: string; title?: string | null; artist?: string | null; album?: string | null; entryId?: number }
export interface RemotePlaylistSnapshot { id: string; name: string; writable: boolean; tracks: RemotePlaylistTrack[] }
export interface RemotePlaylistLink extends ProviderSyncRef { id: string; writable: boolean }
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
export interface RemotePlaylistsAPI {
  status(): Promise<RemotePlaylistStatus[]>
  setEnabled(ref: ProviderSyncRef, enabled: boolean): Promise<void>
  refresh(ref: ProviderSyncRef): Promise<void>
  onChanged(callback: () => void): () => void
}
