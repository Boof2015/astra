export const PHONE_REMOTE_LAN_HOST = '0.0.0.0'
export const PHONE_REMOTE_DEFAULT_PORT = 38402
export const PHONE_REMOTE_MIN_PORT = 1024
export const PHONE_REMOTE_MAX_PORT = 65535

export type PhoneRemotePairingState = 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed'

export interface PhoneRemoteServiceConfig {
  enabled: boolean
  controlsEnabled: boolean
  port: number
}

export interface PhoneRemotePairedDevice {
  id: string
  name: string
  clientLabel: string
  tokenPrefix: string
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
}

export interface PhoneRemotePairingTicket {
  ticket: string
  baseUrl: string
  controllerUrl: string
  pairingUrl: string
  createdAt: number
  expiresAt: number
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
}
