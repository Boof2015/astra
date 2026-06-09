import { EventEmitter } from 'events'
import { networkInterfaces } from 'os'
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

// Step B: retry the PTR query on a stagger so a single packet drop or a sink-side rate-limit
// window (mDNS responders defer 20-120ms per RFC 6762 §6 and won't repeat an identical answer
// inside 1 s) doesn't leave the wizard empty. The constructor's automatic query is treated as
// "t=0"; we add explicit re-queries at the offsets below. Numbers picked to (a) double each step
// per RFC 6762 §5.2 and (b) get the user a result inside ~1 s on a healthy LAN.
const DISCOVERY_QUERY_RETRY_DELAYS_MS = [250, 1000, 2500, 5000] as const

// Diagnosed via Windows-side PARALLAX_DISCOVERY_DEBUG: multicast-dns's `defaultInterface()`
// returns `'0.0.0.0'` on non-darwin and the Windows kernel was picking a VMware/Hyper-V virtual
// adapter (172.16.188.1) for outbound multicast. Inbound mDNS worked (addMembership runs on all
// interfaces) so other devices' responses arrived fine — but Windows's responses to mac's
// queries went out the virtual NIC and never reached the LAN. Fix: pick a primary LAN IPv4
// ourselves and pin Bonjour to it. `PARALLAX_DISCOVERY_INTERFACE` is the manual override for
// when the heuristic guesses wrong (multi-LAN host, weird VLAN setup, etc.).
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

// Diagnostic logging for the "sink already advertising before host opens wizard → never appears"
// bug. Off by default — set `PARALLAX_DISCOVERY_DEBUG=1` to see every PTR query send, every raw
// mDNS response packet, every browser-level event, and every up-the-stack emit. Once tagged on
// either side, the log line tells you which step in the chain dropped the sink.
const DISCOVERY_DEBUG =
  process.env.PARALLAX_DISCOVERY_DEBUG === '1' ||
  process.env.PARALLAX_DISCOVERY_DEBUG === 'true'
function dbg(...args: unknown[]): void {
  if (DISCOVERY_DEBUG) console.log('[parallax-discovery]', ...args)
}

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
  // Diagnostic-only: attach 'response' / 'query' listeners to the underlying multicast-dns
  // socket the first time we touch Bonjour, so we can tell whether the sink's response is even
  // arriving on the host. Tracked so we don't double-attach if Bonjour is reused.
  private debugTapInstalled = false
  // Step B: timers for the PTR query retry stagger. Cleared on stopBrowse so we don't keep
  // re-querying after the wizard closes (and don't leak handles into the next browse session).
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
      dbg('ensureBonjour: creating new Bonjour instance')
      // bonjour-service's options shape is `Partial<ServiceConfig>`; `bind` / `interface` aren't
      // in that type but are read by the underlying multicast-dns layer. Cast through unknown.
      //
      // Key trick (revealed by Windows-side testing where pinning `interface` alone broke
      // receive): on Windows, binding a UDP socket to a specific unicast IP makes the OS only
      // deliver packets explicitly addressed to that IP — multicast (224.0.0.251) gets dropped.
      // We instead bind to 0.0.0.0 so any interface can receive, and use `interface` *only* to
      // direct `addMembership` + `setMulticastInterface` (i.e., the multicast group join and the
      // outbound NIC choice). Linux/macOS are tolerant of either pattern; Windows isn't.
      const bonjourOpts = (picked
        ? { bind: '0.0.0.0', interface: picked.ip }
        : {}) as unknown as Record<string, unknown>
      this.bonjour = new Bonjour(bonjourOpts, (error: unknown) => {
        if (error) console.warn('Parallax discovery transport error:', error)
      })
      this.installDebugTap()
    }
    return this.bonjour
  }

  // Tap the underlying `multicast-dns` socket for raw 'query' and 'response' packets so the log
  // can confirm: (a) we sent the PTR query, (b) the sink's response actually came back. Only
  // installed when PARALLAX_DISCOVERY_DEBUG is on — we reach through Bonjour's private `server`
  // field, which is stable in `bonjour-service` v1.x but obviously not part of the public API.
  private installDebugTap(): void {
    if (!DISCOVERY_DEBUG || this.debugTapInstalled || !this.bonjour) return
    try {
      const internal = this.bonjour as unknown as {
        server?: { mdns?: { on: (event: string, cb: (...args: unknown[]) => void) => void } }
      }
      const mdns = internal.server?.mdns
      if (!mdns) {
        dbg('installDebugTap: could not reach internal mdns instance')
        return
      }
      mdns.on('query', (packet: unknown, rinfo: unknown) => {
        const q = packet as { questions?: Array<{ name?: string; type?: string }> } | undefined
        const info = rinfo as { address?: string; port?: number } | undefined
        const questions = q?.questions?.map((qq) => `${qq.type ?? '?'} ${qq.name ?? '?'}`) ?? []
        dbg(
          `mdns query from ${info?.address ?? '?'}:${info?.port ?? '?'} —`,
          questions.join(' | ')
        )
      })
      mdns.on('response', (packet: unknown, rinfo: unknown) => {
        const r = packet as {
          answers?: Array<{ name?: string; type?: string; data?: unknown }>
          additionals?: Array<{ name?: string; type?: string; data?: unknown }>
        } | undefined
        const info = rinfo as { address?: string; port?: number } | undefined
        const answerSummary = r?.answers?.map((a) => `${a.type ?? '?'} ${a.name ?? '?'}`) ?? []
        const additionalSummary =
          r?.additionals?.map((a) => `${a.type ?? '?'} ${a.name ?? '?'}`) ?? []
        dbg(
          `mdns response from ${info?.address ?? '?'}:${info?.port ?? '?'} — answers:`,
          answerSummary.join(' | ') || '(none)',
          '— additionals:',
          additionalSummary.join(' | ') || '(none)'
        )
      })
      this.debugTapInstalled = true
      dbg('installDebugTap: attached query+response tap to underlying mdns')
    } catch (error) {
      dbg('installDebugTap: failed —', error)
    }
  }

  startAdvertising(options: ParallaxDiscoveryAdvertiseOptions): void {
    dbg(
      `startAdvertising: name=${options.name} port=${options.port} endpointUuid=${options.endpointUuid}`
    )
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
    if (DISCOVERY_DEBUG) {
      const svc = this.advertisedService as unknown as {
        on?: (event: string, cb: () => void) => void
      }
      svc.on?.('up', () => dbg('advertised service emitted "up" — record now responding'))
    }
  }

  stopAdvertising(): void {
    if (this.advertisedService) {
      dbg('stopAdvertising')
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
      dbg(
        `startBrowse: browser already alive — re-query + replay ${this.browser.services?.length ?? 0} cached`
      )
      this.refreshBrowse()
      this.replayKnownServices()
      return
    }
    dbg('startBrowse: creating new browser')
    const bonjour = this.ensureBonjour()
    this.browser = bonjour.find({
      type: PARALLAX_DISCOVERY_SERVICE_TYPE,
      protocol: PARALLAX_DISCOVERY_PROTOCOL
    })
    this.browser.on('up', (service) => {
      dbg(`browser "up": name=${service.name} fqdn=${service.fqdn} port=${service.port}`)
      this.handleServiceAdded(service)
    })
    this.browser.on('down', (service) => {
      dbg(`browser "down": fqdn=${service.fqdn}`)
      this.handleServiceRemoved(service)
    })
    this.browser.on('txt-update', (next) => {
      dbg(`browser "txt-update": fqdn=${next.fqdn}`)
      this.handleServiceAdded(next)
    })
    this.browser.on('srv-update', (next) => {
      dbg(`browser "srv-update": fqdn=${next.fqdn}`)
      this.handleServiceAdded(next)
    })
    this.refreshBrowse()
    this.replayKnownServices()
    this.scheduleQueryRetries()
  }

  stopBrowse(): void {
    if (!this.browser) return
    dbg('stopBrowse')
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
    const discovered = mapServiceToDiscoveredSink(service)
    if (!discovered) {
      dbg(
        `handleServiceAdded: dropped — mapper rejected (no IPv4 or no port). fqdn=${service.fqdn} addrs=${JSON.stringify(service.addresses)} port=${service.port}`
      )
      return
    }
    // Filter self-discoveries — the multicast loopback bounces our own advertisement back.
    if (this.ownEndpointUuid && discovered.endpointUuid === this.ownEndpointUuid) {
      dbg(`handleServiceAdded: dropped — self-discovery (endpointUuid=${discovered.endpointUuid})`)
      return
    }
    dbg(
      `handleServiceAdded: EMIT added — name=${discovered.name} baseUrl=${discovered.baseUrl} endpointUuid=${discovered.endpointUuid ?? '(none)'}`
    )
    this.emit('event', { type: 'added', sink: discovered })
  }

  private handleServiceRemoved(service: Service): void {
    const address = pickServiceAddress(service)
    if (!address) {
      dbg(`handleServiceRemoved: dropped — no IPv4 address. fqdn=${service.fqdn}`)
      return
    }
    const endpointUuid = pickServiceTxt(service, 'endpoint_uuid')
    if (this.ownEndpointUuid && endpointUuid === this.ownEndpointUuid) {
      dbg('handleServiceRemoved: dropped — self-discovery')
      return
    }
    dbg(`handleServiceRemoved: EMIT removed — address=${address}:${service.port}`)
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
      dbg('refreshBrowse: sending PTR query (browser.update)')
      this.browser.update()
    } catch (error) {
      console.warn('Failed to refresh Parallax discovery browser:', error)
    }
  }

  // Step B: stagger re-queries so single UDP packet drops or sink-side 1 s rate-limit windows
  // don't leave the wizard empty. The two synchronous queries we fire in startBrowse (constructor
  // + first refreshBrowse) covered the "sink turns on while wizard is open" case fine, but the
  // "sink was already up before the wizard opened" path is exactly where a single drop costs
  // the user the result — diagnosed via PARALLAX_DISCOVERY_DEBUG: queries were going out,
  // responses sometimes never arrived until a 3rd or 4th query.
  private scheduleQueryRetries(): void {
    this.clearQueryRetries()
    for (const delayMs of DISCOVERY_QUERY_RETRY_DELAYS_MS) {
      const timer = setTimeout(() => {
        // stopBrowse cleared timers + nulled the browser; guard so a fire-after-stop is a no-op.
        if (!this.browser) return
        dbg(`scheduleQueryRetries: t=${delayMs}ms — re-querying`)
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
    const services = this.browser.services
    dbg(`replayKnownServices: replaying ${services.length} cached service(s)`)
    for (const service of services) {
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
