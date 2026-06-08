import { EventEmitter } from 'events'
import Bonjour from 'bonjour-service'
// `bonjour-service` uses `export =` so type-only inner imports go through the dist path. The
// Service class is the shape of every event payload from the Browser; Browser is what `find()`
// returns.
import type { Service } from 'bonjour-service/dist/lib/service'
import type { Browser } from 'bonjour-service/dist/lib/browser'
import type { ParallaxDiscoveredSink, ParallaxDiscoveryEvent } from '../../types/parallax'

// §20 / §14.1.5 Commit 2. Thin wrapper around `bonjour-service` for Astra zone-display
// discovery. Two independent operations:
//
//   - `startAdvertising(...)` publishes the local sink-listener address over mDNS so other
//     Astras can discover it. Runs while `parallaxSinkEnabled` is true.
//   - `startBrowse()` subscribes to incoming service announcements; renderer wizard turns this
//     on while the "Add Sink" modal is open, off when it closes.
//
// Codex §20.19(f) note: `bonjour-service`'s API expects the human form `{ type: 'astra-zone',
// protocol: 'tcp' }`, NOT the wire form `_astra-zone._tcp`. The library prepends `_` and
// appends `._tcp` on the wire automatically.
//
// TXT records (Codex-approved): `version` / `name` / `endpoint_uuid`. No credentials. No `url`
// either — `baseUrl` is derived by the discoverer from the resolved A record + SRV port
// (Codex round 1, high: an advertiser cannot honestly serialize "my URL" on a multi-interface
// host, and `0.0.0.0` would never be reachable from peers).

export const PARALLAX_DISCOVERY_SERVICE_TYPE = 'astra-zone'
export const PARALLAX_DISCOVERY_PROTOCOL: 'tcp' = 'tcp'
const PARALLAX_DISCOVERY_TXT_VERSION = 1

export interface ParallaxDiscoveryAdvertiseOptions {
  name: string
  port: number
  endpointUuid: string
}

interface ParallaxDiscoveryEvents {
  event: [ParallaxDiscoveryEvent]
}

export class ParallaxDiscoveryService extends EventEmitter<ParallaxDiscoveryEvents> {
  private bonjour: Bonjour | null = null
  private advertisedService: Service | null = null
  private browser: Browser | null = null
  // Local installs see their own advertisement bounce back through the multicast loop. Tracking
  // the locally-advertised endpoint UUID lets the browse path filter self-discoveries before
  // they reach the renderer, so the wizard never lists "this device" as a pairable target.
  private ownEndpointUuid: string | null = null

  // Reuse one Bonjour instance for both advertise and browse — `bonjour-service` shares a
  // multicast socket per instance, so creating two would either fight for the same port or
  // double the UDP traffic.
  private ensureBonjour(): Bonjour {
    if (!this.bonjour) {
      this.bonjour = new Bonjour({}, (error: unknown) => {
        if (error) console.warn('Parallax discovery transport error:', error)
      })
    }
    return this.bonjour
  }

  startAdvertising(options: ParallaxDiscoveryAdvertiseOptions): void {
    this.stopAdvertising()
    const bonjour = this.ensureBonjour()
    this.ownEndpointUuid = options.endpointUuid || null
    // Codex round 1 finding (high): don't advertise a TXT `url` — the host's bind address
    // (`0.0.0.0` or any single chosen interface) is unreachable from a peer's perspective on a
    // multi-interface machine. The A/AAAA records mDNS publishes carry the actual reachable
    // addresses; let the discoverer derive `baseUrl` from those + the SRV port.
    this.advertisedService = bonjour.publish({
      name: options.name,
      type: PARALLAX_DISCOVERY_SERVICE_TYPE,
      protocol: PARALLAX_DISCOVERY_PROTOCOL,
      port: options.port,
      txt: {
        version: String(PARALLAX_DISCOVERY_TXT_VERSION),
        name: options.name,
        endpoint_uuid: options.endpointUuid
      }
    })
  }

  stopAdvertising(): void {
    if (this.advertisedService) {
      try {
        this.advertisedService.stop?.()
      } catch (error) {
        console.warn('Failed to stop Parallax discovery advertisement:', error)
      }
      this.advertisedService = null
    }
    this.ownEndpointUuid = null
  }

  startBrowse(): void {
    if (this.browser) {
      this.refreshBrowse()
      this.replayKnownServices()
      return
    }
    const bonjour = this.ensureBonjour()
    this.browser = bonjour.find({
      type: PARALLAX_DISCOVERY_SERVICE_TYPE,
      protocol: PARALLAX_DISCOVERY_PROTOCOL
    })
    this.browser.on('up', (service) => this.handleServiceAdded(service))
    this.browser.on('down', (service) => this.handleServiceRemoved(service))
    this.browser.on('txt-update', (next) => this.handleServiceAdded(next))
    this.browser.on('srv-update', (next) => this.handleServiceAdded(next))
    this.refreshBrowse()
    this.replayKnownServices()
  }

  stopBrowse(): void {
    if (!this.browser) return
    try {
      this.browser.stop?.()
    } catch (error) {
      console.warn('Failed to stop Parallax discovery browser:', error)
    }
    this.browser = null
  }

  // Idempotent full shutdown. Call on app quit / when tearing down the parallax service.
  destroy(): void {
    this.stopBrowse()
    this.stopAdvertising()
    if (this.bonjour) {
      try {
        this.bonjour.destroy()
      } catch (error) {
        console.warn('Failed to destroy Parallax discovery Bonjour instance:', error)
      }
      this.bonjour = null
    }
    this.removeAllListeners()
  }

  private handleServiceAdded(service: Service): void {
    const discovered = mapServiceToDiscoveredSink(service)
    if (!discovered) return
    // Filter self-discoveries — the multicast loopback bounces our own advertisement back.
    if (this.ownEndpointUuid && discovered.endpointUuid === this.ownEndpointUuid) return
    this.emit('event', { type: 'added', sink: discovered })
  }

  private handleServiceRemoved(service: Service): void {
    const address = pickServiceAddress(service)
    if (!address) return
    const endpointUuid = pickServiceTxt(service, 'endpoint_uuid')
    if (this.ownEndpointUuid && endpointUuid === this.ownEndpointUuid) return
    this.emit('event', {
      type: 'removed',
      endpointUuid: endpointUuid || null,
      address,
      port: service.port
    })
  }

  private refreshBrowse(): void {
    if (!this.browser) return
    try {
      // Constructor-time start() already sends one PTR query, but explicit refresh keeps each
      // wizard open/reopen honest and covers the "sink was already advertising before browse
      // started" timing edge reported in manual testing.
      this.browser.update()
    } catch (error) {
      console.warn('Failed to refresh Parallax discovery browser:', error)
    }
  }

  private replayKnownServices(): void {
    if (!this.browser) return
    for (const service of this.browser.services) {
      this.handleServiceAdded(service)
    }
  }
}

function mapServiceToDiscoveredSink(service: Service): ParallaxDiscoveredSink | null {
  const address = pickServiceAddress(service)
  if (!address || !Number.isFinite(service.port)) return null
  const name = pickServiceTxt(service, 'name') || service.name || address
  const endpointUuid = pickServiceTxt(service, 'endpoint_uuid')
  const versionRaw = pickServiceTxt(service, 'version')
  const version = versionRaw ? Number(versionRaw) : null
  // Codex round 1 finding (high): `baseUrl` is always derived from the resolved A-record
  // address + SRV port. Any TXT `url` (legacy, third-party, or from a misconfigured advertiser
  // that included a bind address like `0.0.0.0`) is ignored. The wizard's pair-request flow
  // needs a reachable URL, and the mDNS-resolved address is authoritative for that.
  const baseUrl = `http://${address}:${service.port}`
  return {
    endpointUuid: endpointUuid || null,
    name,
    baseUrl,
    address,
    port: service.port,
    version: Number.isFinite(version as number) ? (version as number) : null,
    lastSeenAt: Date.now()
  }
}

function pickServiceAddress(service: Service): string | null {
  // Codex round 2 finding (medium): IPv4-only for v1. The `baseUrl` interpolation
  // `http://${address}:${port}` does not bracket IPv6 addresses, so an IPv6-only discovery row
  // would render in the wizard but be unpairable. Falling back to a non-IPv4 here would
  // surface that broken row; instead reject so the mapper drops it entirely. IPv6 support can
  // come later with proper `[addr]:port` formatting + reachability checks.
  const ipv4Pattern = /^\d{1,3}(\.\d{1,3}){3}$/
  const addresses = Array.isArray(service.addresses) ? service.addresses : []
  const ipv4 = addresses.find((address: string) => ipv4Pattern.test(address))
  if (ipv4) return ipv4
  const refererAddress = service.referer?.address ?? null
  if (refererAddress && ipv4Pattern.test(refererAddress)) return refererAddress
  return null
}

function pickServiceTxt(service: Service, key: string): string {
  const txt = service.txt as Record<string, unknown> | undefined
  if (!txt) return ''
  const value = txt[key]
  if (typeof value === 'string') return value
  if (value instanceof Buffer) return value.toString('utf8')
  if (value == null) return ''
  return String(value)
}
