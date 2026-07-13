import Bonjour from 'bonjour-service'
import type { Service } from 'bonjour-service/dist/lib/service'

export const PHONE_REMOTE_DISCOVERY_SERVICE_TYPE = 'astra-remote'
export const PHONE_REMOTE_DISCOVERY_PROTOCOL: 'tcp' = 'tcp'

interface BonjourLike {
  publish(options: {
    name: string
    type: string
    protocol: 'tcp'
    port: number
    txt: Record<string, string>
  }): Pick<Service, 'stop'>
  destroy?: () => void
}

export interface PhoneRemoteDiscoveryAdvertiseOptions {
  name: string
  port: number
  endpointUuid: string | null
  protocolVersion: number
  transport: 'https'
  certificateFingerprint: string
}

export interface PhoneRemoteDiscoveryServiceOptions {
  createBonjour?: () => BonjourLike
}

export class PhoneRemoteDiscoveryService {
  private readonly createBonjour: () => BonjourLike
  private bonjour: BonjourLike | null = null
  private advertisedService: Pick<Service, 'stop'> | null = null
  private advertisedSignature: string | null = null

  constructor(options: PhoneRemoteDiscoveryServiceOptions = {}) {
    this.createBonjour = options.createBonjour ?? (() => new Bonjour() as BonjourLike)
  }

  startAdvertising(options: PhoneRemoteDiscoveryAdvertiseOptions): void {
    const normalized = {
      name: options.name.trim() || 'Astra Desktop',
      port: options.port,
      endpointUuid: options.endpointUuid?.trim() || '',
      protocolVersion: Number.isFinite(options.protocolVersion)
        ? Math.max(1, Math.floor(options.protocolVersion))
        : 1,
      transport: options.transport,
      certificateFingerprint: options.certificateFingerprint.trim()
    }
    const signature = JSON.stringify(normalized)
    if (this.advertisedSignature === signature && this.advertisedService) return

    this.stopAdvertising()
    const bonjour = this.ensureBonjour()
    this.advertisedService = bonjour.publish({
      name: normalized.name,
      type: PHONE_REMOTE_DISCOVERY_SERVICE_TYPE,
      protocol: PHONE_REMOTE_DISCOVERY_PROTOCOL,
      port: normalized.port,
      txt: {
        version: '1',
        name: normalized.name,
        endpoint_uuid: normalized.endpointUuid,
        protocol_version: String(normalized.protocolVersion),
        transport: normalized.transport,
        certificate_fingerprint: normalized.certificateFingerprint
      }
    })
    this.advertisedSignature = signature
  }

  stopAdvertising(): void {
    if (this.advertisedService) {
      try {
        this.advertisedService.stop?.()
      } catch (error) {
        console.warn('Failed to stop phone remote discovery advertisement:', error)
      }
    }
    this.advertisedService = null
    this.advertisedSignature = null
  }

  destroy(): void {
    this.stopAdvertising()
    if (this.bonjour) {
      try {
        this.bonjour.destroy?.()
      } catch (error) {
        console.warn('Failed to destroy phone remote discovery service:', error)
      }
    }
    this.bonjour = null
  }

  private ensureBonjour(): BonjourLike {
    if (!this.bonjour) this.bonjour = this.createBonjour()
    return this.bonjour
  }
}
