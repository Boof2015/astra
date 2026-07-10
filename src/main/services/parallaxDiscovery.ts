import { EventEmitter } from 'events'
import { networkInterfaces } from 'os'
import Bonjour from 'bonjour-service'
// `bonjour-service` uses `export =` so type-only inner imports go through the dist path. The
// Service class is the shape of every event payload from the Browser; Browser is what `find()`
// returns.
import type { Service } from 'bonjour-service/dist/lib/service'
import type { Browser } from 'bonjour-service/dist/lib/browser'
import {
  PARALLAX_PROTOCOL_VERSION,
  type ParallaxDiscoveredSink,
  type ParallaxDiscoveryEvent
} from '../../types/parallax'

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
const PARALLAX_DISCOVERY_TXT_VERSION = PARALLAX_PROTOCOL_VERSION

// Retry the PTR query on a stagger so a single packet drop or a sink-side rate-limit window
// (mDNS responders defer 20-120ms per RFC 6762 §6 and won't repeat an identical answer inside
// 1 s) doesn't leave the wizard empty. The constructor's automatic query is treated as "t=0";
// these are explicit re-queries on top. Doubling each step per RFC 6762 §5.2.
const DISCOVERY_QUERY_RETRY_DELAYS_MS = [250, 1000, 2500, 5000] as const

// On Windows, multicast-dns's `defaultInterface()` returns `'0.0.0.0'` for non-darwin and the
// kernel was picking a virtual adapter (VMware vmnet / Hyper-V vEthernet) for outbound
// multicast — responses then never reached the LAN. Fix: pick a primary LAN IPv4 ourselves and
// pin Bonjour to it (see `ensureBonjour`). `PARALLAX_DISCOVERY_INTERFACE` is the manual
// override for the case where the heuristic guesses wrong (multi-LAN host, VLAN, etc.).
const DISCOVERY_INTERFACE_OVERRIDE = process.env.PARALLAX_DISCOVERY_INTERFACE?.trim() || null

// Interface names we never want for mDNS — virtual adapters (Hyper-V vEthernet, VMware vmnet,
// VirtualBox host-only, Docker, WSL2), tunnels (utun, tun, tap, tunnel, vpn), and a couple of
// Apple internal radios (awdl = Apple Wireless Direct Link, llw = low-latency WLAN, bridge =
// Internet-Sharing bridge). Match is case-insensitive substring.
const DISCOVERY_VIRTUAL_NAME_PATTERN =
  /vethernet|vmnet|virtualbox|hyper-v|wsl|pseudo|tunnel|vpn|docker|virbr|awdl|llw|utun|^tap|^tun|bridge|bluetooth|loopback/i

// Lower priority value = preferred. RFC 1918 home LANs are overwhelmingly 192.168/16. 10/8 is
// next-most-common. 172.16/12 is real RFC 1918 space but is also where most consumer
// virtualization (VMware vmnet, Docker Desktop, some VPNs) lives — so we rank it last and
// strongly prefer the other two. Anything outside RFC 1918 is "weird/public" and worse still.
function ipPriority(ip: string): number {
  if (ip.startsWith('192.168.')) return 0
  if (ip.startsWith('10.')) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 3
  return 2
}

interface DiscoveryInterfacePick {
  ip: string
  name: string
}

function pickDiscoveryInterface(): DiscoveryInterfacePick | null {
  if (DISCOVERY_INTERFACE_OVERRIDE) {
    return { ip: DISCOVERY_INTERFACE_OVERRIDE, name: '(env override)' }
  }
  const candidates: Array<{ name: string; ip: string; priority: number }> = []
  const ifaces = networkInterfaces()
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list) continue
    if (DISCOVERY_VIRTUAL_NAME_PATTERN.test(name)) continue
    for (const iface of list) {
      if (iface.family !== 'IPv4') continue
      if (iface.internal) continue
      // Link-local APIPA (169.254/16) means the adapter never got a DHCP lease — useless for LAN.
      if (iface.address.startsWith('169.254.')) continue
      candidates.push({ name, ip: iface.address, priority: ipPriority(iface.address) })
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.priority - b.priority)
  return { ip: candidates[0].ip, name: candidates[0].name }
}

export type ParallaxDiscoveryRole = 'host' | 'sink'

export interface ParallaxDiscoveryAdvertiseOptions {
  name: string
  port: number
  endpointUuid: string
  // §Pillar 3. Distinguishes a host advertisement (so a paired sink can relocate it by UUID after
  // its IP changes) from a sink advertisement (what the pairing wizard browses for). The pairing
  // wizard filters to `role=sink`; the sink's relocation browse filters to `role=host`.
  role: ParallaxDiscoveryRole
}

// §Pillar 3. A host located by `resolveHostByUuid` — the current reachable address of a paired host
// that has moved. `baseUrl` is derived from the resolved A-record + SRV port (same rule as the
// wizard's sink discovery), never from a TXT field.
export interface ParallaxResolvedHost {
  endpointUuid: string
  baseUrl: string
  address: string
  port: number
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
  // Timers for the PTR query retry stagger. Cleared on stopBrowse so we don't keep re-querying
  // after the wizard closes (and don't leak handles into the next browse session).
  private queryRetryTimers: NodeJS.Timeout[] = []

  // Reuse one Bonjour instance for both advertise and browse — `bonjour-service` shares a
  // multicast socket per instance, so creating two would either fight for the same port or
  // double the UDP traffic.
  private ensureBonjour(): Bonjour {
    if (!this.bonjour) {
      // Pin Bonjour to the LAN interface we picked instead of letting multicast-dns fall back
      // to '0.0.0.0' (which on Windows means "kernel picks" — and the kernel picks a virtual
      // adapter). If we couldn't find a candidate, fall through with no `interface` and let the
      // library default win; that's still useful on macOS where its default already chose en0.
      const picked = pickDiscoveryInterface()
      if (picked) {
        console.log(
          `[parallax-discovery] using interface ${picked.ip} (${picked.name}) for mDNS`
        )
      } else {
        console.warn(
          '[parallax-discovery] could not pick a LAN interface — falling back to OS default. Multi-NIC hosts (especially Windows with virtual adapters) may need PARALLAX_DISCOVERY_INTERFACE=<ip>.'
        )
      }
      // bonjour-service's options shape is `Partial<ServiceConfig>`; `bind` / `interface` aren't
      // in that type but are read by the underlying multicast-dns layer. Cast through unknown.
      //
      // Bind 0.0.0.0 + pin `interface` is the Windows-correct shape: binding a UDP socket to a
      // specific unicast IP on Windows makes the OS only deliver packets explicitly addressed to
      // that IP — multicast (224.0.0.251) gets dropped. We instead bind ANY so any NIC can
      // receive, and use `interface` *only* to direct `addMembership` + `setMulticastInterface`
      // (multicast group join + outbound NIC choice). Linux/macOS tolerate either pattern.
      const bonjourOpts = (picked
        ? { bind: '0.0.0.0', interface: picked.ip }
        : {}) as unknown as Record<string, unknown>
      this.bonjour = new Bonjour(bonjourOpts, (error: unknown) => {
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
        endpoint_uuid: options.endpointUuid,
        role: options.role
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
    this.scheduleQueryRetries()
  }

  stopBrowse(): void {
    if (!this.browser) return
    this.clearQueryRetries()
    try {
      this.browser.stop?.()
    } catch (error) {
      console.warn('Failed to stop Parallax discovery browser:', error)
    }
    this.browser = null
  }

  // Idempotent full shutdown. Call on app quit / when tearing down the parallax service.
  destroy(): void {
    this.clearQueryRetries()
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
    // §Pillar 3. The wizard browses for pairable sinks only. Skip host advertisements (role=host).
    // Pre-Pillar-3 sinks carry no role; treat a missing role as 'sink' for backward compatibility.
    const role = pickServiceTxt(service, 'role')
    if (role && role !== 'sink') return
    const discovered = mapServiceToDiscoveredSink(service)
    if (!discovered) return
    // Filter self-discoveries — the multicast loopback bounces our own advertisement back.
    if (this.ownEndpointUuid && discovered.endpointUuid === this.ownEndpointUuid) return
    this.emit('event', { type: 'added', sink: discovered })
  }

  // §Pillar 3 — sink-side host relocation. When a paired host's persisted baseUrl stops working
  // (it moved to a new IP after a sleep/wake or network change), find its current address by
  // browsing for the role=host advertisement carrying the remembered endpoint UUID. One-shot:
  // resolves with the first match or null on timeout, and leaves no persistent browser running so
  // it never interferes with the wizard's continuous browse. Reuses the shared Bonjour socket.
  async resolveHostByUuid(endpointUuid: string, timeoutMs: number): Promise<ParallaxResolvedHost | null> {
    const target = endpointUuid.trim()
    if (!target) return null
    const bonjour = this.ensureBonjour()
    return await new Promise<ParallaxResolvedHost | null>((resolve) => {
      let settled = false
      const browser = bonjour.find({
        type: PARALLAX_DISCOVERY_SERVICE_TYPE,
        protocol: PARALLAX_DISCOVERY_PROTOCOL
      })
      const finish = (result: ParallaxResolvedHost | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { browser.stop?.() } catch { /* ignore */ }
        resolve(result)
      }
      const consider = (service: Service): void => {
        if (pickServiceTxt(service, 'role') !== 'host') return
        if (pickServiceTxt(service, 'endpoint_uuid') !== target) return
        const address = pickServiceAddress(service)
        if (!address || !Number.isFinite(service.port)) return
        const version = Number(pickServiceTxt(service, 'version'))
        if (version !== PARALLAX_PROTOCOL_VERSION) return
        finish({ endpointUuid: target, baseUrl: `https://${address}:${service.port}`, address, port: service.port })
      }
      browser.on('up', consider)
      browser.on('srv-update', consider)
      browser.on('txt-update', consider)
      // Replay anything already cached from a prior/concurrent browse so we don't always wait a
      // full query round-trip when the host is already known.
      for (const service of browser.services) consider(service)
      const timer = setTimeout(() => finish(null), timeoutMs)
      timer.unref?.()
    })
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
      // started" case.
      this.browser.update()
    } catch (error) {
      console.warn('Failed to refresh Parallax discovery browser:', error)
    }
  }

  // Stagger re-queries so single UDP packet drops or sink-side 1 s rate-limit windows don't
  // leave the wizard empty. The two synchronous queries fired in startBrowse (constructor + first
  // refreshBrowse) covered the "sink turns on while wizard is open" case fine, but the
  // "sink was already up before the wizard opened" path is exactly where a single drop costs the
  // user the result.
  private scheduleQueryRetries(): void {
    this.clearQueryRetries()
    for (const delayMs of DISCOVERY_QUERY_RETRY_DELAYS_MS) {
      const timer = setTimeout(() => {
        // stopBrowse cleared timers + nulled the browser; guard so a fire-after-stop is a no-op.
        if (!this.browser) return
        this.refreshBrowse()
      }, delayMs)
      // Don't keep the event loop alive just for retries — if the user quits during a wizard
      // session, the discovery timers shouldn't block exit.
      timer.unref?.()
      this.queryRetryTimers.push(timer)
    }
  }

  private clearQueryRetries(): void {
    if (this.queryRetryTimers.length === 0) return
    for (const timer of this.queryRetryTimers) clearTimeout(timer)
    this.queryRetryTimers = []
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
  const normalizedVersion = Number.isFinite(version as number) ? (version as number) : null
  return {
    endpointUuid: endpointUuid || null,
    name,
    baseUrl,
    address,
    port: service.port,
    version: normalizedVersion,
    compatible: normalizedVersion === PARALLAX_PROTOCOL_VERSION,
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
