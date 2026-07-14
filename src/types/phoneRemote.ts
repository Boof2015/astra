import type { PhoneSyncPendingResolution, PhoneSyncReportedConflict } from './phoneSync'
import type { CompanionApiScope } from './companionApi'

export const PHONE_REMOTE_LAN_HOST = '0.0.0.0'
export const PHONE_REMOTE_DEFAULT_PORT = 38402
export const PHONE_REMOTE_MIN_PORT = 1024
export const PHONE_REMOTE_MAX_PORT = 65535
// v3: pinned HTTPS transport, scoped control/sync credentials, secure PIN
// pairing, credential rotation, and inactivity expiry.
export const PHONE_REMOTE_PROTOCOL_VERSION = 3

export interface PhoneRemoteIdentity {
  endpointUuid: string | null
  desktopName: string
  protocolVersion: number
}

export type PhoneRemotePairingMode = 'approval' | 'pin'
export type PhoneRemoteClientKind = 'native' | 'web'
export type PhoneRemoteCredentialScope = 'control' | 'sync' | CompanionApiScope

export type PhoneRemotePairingState = 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed'

export interface PhoneRemoteServiceConfig {
  enabled: boolean
  controlsEnabled: boolean
  /** Favorites/playlists library sync — independent of playback controls. */
  syncEnabled: boolean
  port: number
}

export interface PhoneRemotePairedDevice {
  id: string
  name: string
  clientLabel: string
  tokenPrefix: string
  syncTokenPrefix: string | null
  clientKind: PhoneRemoteClientKind
  scopes: PhoneRemoteCredentialScope[]
  credentialIssuedAt: number
  credentialRotatedAt: number
  expiresAt: number
  createdAt: number
  lastSeenAt: number | null
  revokedAt: number | null
}

export interface PhoneRemotePendingPairingRequest {
  id: string
  deviceName: string
  clientLabel: string
  requestedAt: number
  expiresAt: number
  baseUrl: string
  pairingMode: PhoneRemotePairingMode
  pin: string | null
  requestedScopes: CompanionApiScope[]
}

export interface PhoneRemotePairingTicket {
  ticket: string
  baseUrl: string
  controllerUrl: string
  pairingUrl: string
  createdAt: number
  expiresAt: number
  identity: PhoneRemoteIdentity
  clientKind: PhoneRemoteClientKind
  certificateFingerprint: string
}

export interface PhoneRemoteSyncStatus {
  enabled: boolean
  /** Set while a desktop-initiated sync request awaits phone pickup. */
  requestedAt: number | null
  /** When the phone last completed a sync run against this desktop. */
  lastSyncedAt: number | null
  conflicts: PhoneSyncReportedConflict[]
  pendingResolutions: PhoneSyncPendingResolution[]
}

export interface PhoneRemoteStatus {
  enabled: boolean
  controlsEnabled: boolean
  bindHost: string
  port: number
  lanUrls: string[]
  controllerUrl: string | null
  active: boolean
  connectedClients: number
  pairedDeviceCount: number
  pendingPairingCount: number
  lastError: string | null
  identity: PhoneRemoteIdentity
  sync: PhoneRemoteSyncStatus
}
