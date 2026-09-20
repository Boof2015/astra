import Bonjour from 'bonjour-service'
import { spawn, type ChildProcess } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { networkInterfaces } from 'node:os'
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
  hardwareEnabled?: boolean
  phoneEnabled?: boolean
}

export interface PhoneRemoteDiscoveryServiceOptions {
  createBonjour?: () => BonjourLike
}

type DiscoveryPublication = Parameters<BonjourLike['publish']>[0]
type WindowsService = Pick<Service, 'stop' | 'records' | 'host' | 'destroyed'>

interface WindowsSocketOptions {
  bind: '0.0.0.0'
  port: 5353
  interface: string
  loopback: false
  reuseAddr: true
}

interface WindowsBonjour {
  publish(options: DiscoveryPublication & { probe: true; disableIPv6: true }): WindowsService
  destroy(): void
}

export interface WindowsDiscoveryOptions {
  getInterfaces?: typeof networkInterfaces
  createBonjour?: (options: WindowsSocketOptions, onError: (error: unknown) => void) => WindowsBonjour
  scheduleRefresh?: (refresh: () => void, intervalMs: number) => () => void
  log?: (message: string) => void
}

function createWindowsBonjour(options: WindowsSocketOptions, onError: (error: unknown) => void): WindowsBonjour {
  // bonjour-service forwards socket options to multicast-dns, but does not
  // expose its transport events or include those options in its public types.
  const bonjour = new Bonjour(options as unknown as ConstructorParameters<typeof Bonjour>[0], onError)
  const mdns = (bonjour as unknown as { server: { mdns: EventEmitter } }).server.mdns
  mdns.on('error', onError)
  mdns.on('warning', onError)
  return bonjour
}

// A Thing is a USB network peer. On Windows, multicast-dns joins every adapter
// but sends through only the OS default. Give each address its own responder;
// binding ANY is necessary for Windows to deliver multicast to these sockets.
export function createWindowsDiscoveryBonjour(options: WindowsDiscoveryOptions = {}): BonjourLike {
  const getInterfaces = options.getInterfaces ?? networkInterfaces
  const createBonjour = options.createBonjour ?? createWindowsBonjour
  const log = options.log ?? console.info
  const scheduleRefresh = options.scheduleRefresh ?? ((refresh, intervalMs) => {
    const timer = setInterval(refresh, intervalMs)
    timer.unref()
    return () => clearInterval(timer)
  })
  let stopCurrent: (() => void) | null = null

  return {
    publish(publication) {
      stopCurrent?.()
      let stopped = false
      let cancelRefresh: (() => void) | undefined
      let inventoryError: string | null = null
      const failures = new Map<string, string>()
      const announced = new Set<string>()
      type Advertiser = { bonjour?: WindowsBonjour; service?: WindowsService; failed: boolean; disposed: boolean }
      const advertisers = new Map<string, Advertiser>()

      const dispose = (entry: Advertiser) => {
        if (entry.disposed) return
        entry.disposed = true
        // Stop pending probes/reannouncements even when a goodbye send is still
        // outstanding. A vanished USB adapter must not hold shutdown open.
        if (entry.service) entry.service.destroyed = true
        let closed = false
        const close = () => {
          if (closed) return
          closed = true
          clearTimeout(deadline)
          try { entry.bonjour?.destroy() } catch { /* An unbound/removed socket may already be closed. */ }
        }
        const deadline = setTimeout(close, 500)
        deadline.unref()
        try {
          if (entry.service) entry.service.stop(close)
          else close()
        } catch { close() }
      }

      const refresh = () => {
        if (stopped) return
        const addresses = new Map<string, string>()
        try {
          for (const [name, interfaces] of Object.entries(getInterfaces())) {
            for (const iface of interfaces ?? []) {
              // USB links may legitimately use link-local IPv4. Do not apply
              // Parallax's primary-LAN ranking or virtual-adapter exclusions.
              if (iface.family === 'IPv4' && !iface.internal && iface.address !== '0.0.0.0') {
                addresses.set(iface.address, name)
              }
            }
          }
          inventoryError = null
        } catch (error) {
          const message = String(error)
          if (inventoryError !== message) log(`[phone-remote-discovery] Could not refresh interfaces: ${message}`)
          inventoryError = message
          return
        }

        for (const [address, entry] of advertisers) {
          if (addresses.has(address)) continue
          advertisers.delete(address)
          dispose(entry)
          log(`[phone-remote-discovery] Removed interface ${address}`)
        }
        for (const address of failures.keys()) if (!addresses.has(address)) failures.delete(address)
        for (const address of announced) if (!addresses.has(address)) announced.delete(address)

        for (const [address, name] of addresses) {
          if (advertisers.has(address)) continue
          const entry: Advertiser = { failed: false, disposed: false }
          advertisers.set(address, entry)
          const fail = (error: unknown) => {
            if (stopped || entry.disposed || entry.failed) return
            entry.failed = true
            const message = String(error)
            if (failures.get(address) !== message) log(`[phone-remote-discovery] ${name} (${address}) failed; retrying in 5s: ${message}`)
            failures.set(address, message)
            // multicast-dns can emit a warning partway through socket setup.
            // Retire it after that stack finishes, so its timers are cleaned up.
            queueMicrotask(() => {
              if (advertisers.get(address) === entry) advertisers.delete(address)
              dispose(entry)
            })
          }
          try {
            entry.bonjour = createBonjour({ bind: '0.0.0.0', port: 5353, interface: address, loopback: false, reuseAddr: true }, fail)
            if (entry.failed) continue
            // Keep probing external name conflicts. Disabling socket loopback
            // prevents our other interface responders from conflicting with us.
            const service = entry.bonjour.publish({ ...publication, probe: true, disableIPv6: true })
            entry.service = service
            // Windows hostname() is usually a bare NetBIOS name. mDNS clients
            // (including the Thing) need a .local SRV target to resolve the host.
            const host = service.host.replace(/\.$/, '')
            service.host = /\.local$/i.test(host) ? host : `${host}.local`
            // publish() probes asynchronously before calling records(). Scope
            // both announcements and query replies before that first probe ends.
            const records = service.records.bind(service)
            service.records = () => [
              ...records().filter(record => record.type !== 'A' && record.type !== 'AAAA'),
              { name: service.host, type: 'A', ttl: 120, data: address }
            ]
            if (!announced.has(address)) {
              announced.add(address)
              log(`[phone-remote-discovery] Advertising on ${name} (${address})`)
            }
          } catch (error) { fail(error) }
        }
      }

      const stop = () => {
        if (stopped) return
        stopped = true
        cancelRefresh?.()
        for (const entry of advertisers.values()) dispose(entry)
        advertisers.clear()
        if (stopCurrent === stop) stopCurrent = null
      }
      stopCurrent = stop
      refresh()
      cancelRefresh = scheduleRefresh(refresh, 5000)
      return { stop }
    },
    destroy() { stopCurrent?.() }
  }
}

// macOS's DNS-SD daemon advertises on every eligible interface, including a
// newly attached USB Thing. multicast-dns picks one outbound interface on macOS.
export function createMacDiscoveryBonjour(register: (args: string[]) => ChildProcess =
  args => spawn('/usr/bin/dns-sd', args, { stdio: 'ignore' })): BonjourLike {
  const children = new Set<ChildProcess>()
  return {
    publish(options) {
      const child = register(['-R', options.name, `_${options.type}._${options.protocol}`,
        'local', String(options.port), ...Object.entries(options.txt).map(([key, value]) => `${key}=${value}`)])
      children.add(child)
      child.on('error', error => console.warn('Hardware discovery registration failed:', error.message))
      child.once('exit', () => children.delete(child))
      return { stop: () => { children.delete(child); child.kill() } }
    },
    destroy() { for (const child of children) child.kill(); children.clear() }
  }
}

export class PhoneRemoteDiscoveryService {
  private readonly createBonjour: () => BonjourLike
  private bonjour: BonjourLike | null = null
  private advertisedService: Pick<Service, 'stop'> | null = null
  private advertisedSignature: string | null = null

  constructor(options: PhoneRemoteDiscoveryServiceOptions = {}) {
    this.createBonjour = options.createBonjour ?? (() => process.platform === 'darwin'
      ? createMacDiscoveryBonjour()
      : process.platform === 'win32' ? createWindowsDiscoveryBonjour() : new Bonjour() as BonjourLike)
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
      certificateFingerprint: options.certificateFingerprint.trim(),
      hardwareEnabled: options.hardwareEnabled ?? true,
      phoneEnabled: options.phoneEnabled ?? true
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
        companion_api: '2',
        ...(normalized.hardwareEnabled ? { hardware_pairing: 'hardware-v1' } : {}),
        phone_remote: normalized.phoneEnabled ? '1' : '0',
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
