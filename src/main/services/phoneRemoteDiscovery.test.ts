import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { EventEmitter, once } from 'node:events'
import { createRequire } from 'node:module'
import type { NetworkInterfaceInfo } from 'node:os'
import test from 'node:test'
import Bonjour from 'bonjour-service'
import type { Service, ServiceRecord } from 'bonjour-service/dist/lib/service'
import { createWindowsDiscoveryBonjour, PhoneRemoteDiscoveryService, type WindowsDiscoveryOptions } from './phoneRemoteDiscovery.ts'

const publication = {
  name: 'Music Desktop', type: 'astra-remote', protocol: 'tcp' as const, port: 38402,
  txt: { endpoint_uuid: 'desktop-id', hardware_pairing: 'hardware-v1', certificate_fingerprint: 'AA:BB' }
}

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return { family: 'IPv4', address, internal, netmask: '255.255.255.0', mac: '02:00:00:00:00:01', cidr: `${address}/24` }
}

function harness(initial: Record<string, NetworkInterfaceInfo[]> = {}) {
  let interfaces = initial
  let enumerationFails = false
  const publishers: Array<{
    options: Parameters<NonNullable<WindowsDiscoveryOptions['createBonjour']>>[0]
    fail: (error: unknown) => void
    service?: Service
    stops: number
    destroys: number
  }> = []
  const timers: Array<{ refresh: () => void; cancelled: boolean; interval: number }> = []
  const logs: string[] = []
  const failCreate = new Set<string>()
  const failPublish = new Set<string>()
  const adapter = createWindowsDiscoveryBonjour({
    getInterfaces: () => {
      if (enumerationFails) throw new Error('Interface enumeration unavailable')
      return interfaces
    },
    createBonjour: (options, fail) => {
      if (failCreate.has(options.interface)) throw new Error('Adapter unavailable')
      const publisher: (typeof publishers)[number] = { options, fail, stops: 0, destroys: 0 }
      publishers.push(publisher)
      return {
        publish: options => {
          if (failPublish.has(publisher.options.interface)) throw new Error('Publish unavailable')
          const service = new Bonjour.Service(options, () => {}, (callback: () => void) => {
            publisher.stops++
            callback()
          })
          publisher.service = service
          return service
        },
        destroy: () => { publisher.destroys++ }
      }
    },
    scheduleRefresh: (refresh, interval) => {
      const timer = { refresh, interval, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
    log: message => logs.push(message)
  })
  return {
    adapter, publishers, timers, logs, failCreate, failPublish,
    setInterfaces: (next: typeof interfaces) => { interfaces = next },
    failEnumeration: (fail: boolean) => { enumerationFails = fail },
    tick: () => { for (const timer of timers) if (!timer.cancelled) timer.refresh() }
  }
}

test('Windows publishes the USB address alongside competing adapters, including link-local IPv4', () => {
  const h = harness({
    'Wi-Fi': [ipv4('192.168.1.23')],
    Tailscale: [ipv4('169.254.83.107')],
    'Ethernet 3': [ipv4('10.42.1.238')],
    'VMware Network Adapter VMnet8': [ipv4('172.16.188.1')],
    loopback: [ipv4('127.0.0.1', true)],
    duplicate: [ipv4('10.42.1.238')],
    unassigned: [ipv4('0.0.0.0')],
    ipv6: [{ ...ipv4('::1'), family: 'IPv6', scopeid: 1 }]
  })
  const published = h.adapter.publish(publication)
  assert.deepEqual(h.publishers.map(p => p.options.interface), ['192.168.1.23', '169.254.83.107', '10.42.1.238', '172.16.188.1'])
  for (const p of h.publishers) {
    assert.deepEqual(p.options, { bind: '0.0.0.0', port: 5353, interface: p.options.interface, loopback: false, reuseAddr: true })
    const records = p.service!.records()
    assert.deepEqual(records.filter(r => r.type === 'A').map(r => r.data), [p.options.interface])
    assert.equal(records.some(r => r.type === 'AAAA'), false)
    assert.match(p.service!.host, /\.local$/i)
    assert.equal(records.find(r => r.type === 'SRV')!.data.target, p.service!.host)
    assert.equal(records.find(r => r.type === 'A')!.name, p.service!.host)
    assert.deepEqual(p.service!.txt, publication.txt)
    assert.equal(p.service!.name, publication.name)
    assert.equal(p.service!.port, publication.port)
  }
  assert.equal(h.timers[0].interval, 5000)
  published.stop()
  h.adapter.destroy?.()
  assert.equal(h.timers[0].cancelled, true)
  assert.ok(h.publishers.every(p => p.stops === 1 && p.destroys === 1 && p.service!.destroyed))
})

test('USB attachment, removal, address changes and reattachment are reconciled without restarting', () => {
  const h = harness()
  h.adapter.publish(publication)
  assert.equal(h.publishers.length, 0)
  h.setInterfaces({ 'Wi-Fi': [ipv4('192.168.1.23')] })
  h.tick()
  const wifi = h.publishers[0]
  h.setInterfaces({ 'Wi-Fi': [ipv4('192.168.1.23')], USB: [ipv4('10.42.1.238')] })
  h.tick()
  h.tick()
  assert.equal(h.publishers.length, 2)
  const usb = h.publishers[1]
  h.setInterfaces({ 'Wi-Fi': [ipv4('192.168.1.23')], USB: [ipv4('169.254.10.2')] })
  h.tick()
  assert.equal(usb.destroys, 1)
  assert.equal(wifi.destroys, 0)
  assert.equal(h.publishers[2].options.interface, '169.254.10.2')
  h.setInterfaces({ 'Wi-Fi': [ipv4('192.168.1.23')] })
  h.tick()
  assert.equal(h.publishers[2].destroys, 1)
  h.setInterfaces({ 'Wi-Fi': [ipv4('192.168.1.23')], USB: [ipv4('10.42.1.238')] })
  h.tick()
  assert.equal(h.publishers.length, 4)
  h.adapter.destroy?.()
  assert.ok(h.publishers.every(p => p.destroys === 1))
  h.tick()
  assert.equal(h.publishers.length, 4)
})

test('unchanged starts are idempotent; capability updates replace every advertiser and stale stops are harmless', () => {
  const h = harness({ USB: [ipv4('10.42.1.238')] })
  const discovery = new PhoneRemoteDiscoveryService({ createBonjour: () => h.adapter })
  const options = { name: 'Desktop', port: 38402, endpointUuid: 'desktop-id', protocolVersion: 3, transport: 'https' as const, certificateFingerprint: 'AA:BB' }
  discovery.startAdvertising(options)
  discovery.startAdvertising(options)
  assert.equal(h.publishers.length, 1)
  discovery.startAdvertising({ ...options, hardwareEnabled: false })
  assert.equal(h.publishers[0].destroys, 1)
  assert.equal(h.publishers[1].service!.txt!.hardware_pairing, undefined)
  assert.equal(h.publishers[1].service!.txt!.phone_remote, '1')
  discovery.stopAdvertising()
  assert.ok(h.timers.every(t => t.cancelled))
  discovery.startAdvertising(options)
  discovery.destroy()
  assert.ok(h.publishers.every(p => p.destroys === 1))

  const oldPublication = h.adapter.publish(publication)
  const current = h.adapter.publish(publication)
  oldPublication.stop()
  assert.equal(h.publishers.at(-1)!.destroys, 0)
  current.stop()
  h.adapter.destroy?.()
  assert.ok(h.publishers.every(p => p.destroys === 1))
})

test('adapter failures are isolated, cleaned up and retried; repeated failures do not flood logs', async () => {
  const h = harness({ USB: [ipv4('10.42.1.238')], 'Wi-Fi': [ipv4('192.168.1.23')] })
  h.failCreate.add('10.42.1.238')
  h.adapter.publish(publication)
  await Promise.resolve()
  assert.equal(h.publishers.length, 1)
  const wifi = h.publishers[0]
  h.tick()
  await Promise.resolve()
  assert.equal(h.logs.filter(l => l.includes('failed')).length, 1)
  h.failCreate.clear()
  h.failPublish.add('10.42.1.238')
  h.tick()
  await Promise.resolve()
  assert.equal(h.publishers[1].destroys, 1)
  h.failPublish.clear()
  h.tick()
  const usb = h.publishers[2]
  usb.fail(new Error('ENETDOWN'))
  usb.fail(new Error('ENETDOWN'))
  await Promise.resolve()
  assert.equal(usb.destroys, 1)
  assert.equal(wifi.destroys, 0)
  h.tick()
  assert.equal(h.publishers.length, 4)
  usb.fail(new Error('late callback'))
  await Promise.resolve()
  assert.equal(h.publishers[3].destroys, 0)
  h.adapter.destroy?.()
  assert.ok(h.publishers.every(p => p.destroys === 1))
})

test('failed enumeration preserves live advertisers and a queued failure cannot restart a stopped adapter', async () => {
  const h = harness({ USB: [ipv4('10.42.1.238')] })
  const publicationHandle = h.adapter.publish(publication)
  h.failEnumeration(true)
  h.tick()
  h.tick()
  assert.equal(h.publishers[0].destroys, 0)
  assert.equal(h.logs.filter(l => l.includes('Could not refresh')).length, 1)
  h.failEnumeration(false)
  h.publishers[0].fail(new Error('Socket error'))
  publicationHandle.stop()
  await Promise.resolve()
  h.tick()
  assert.equal(h.publishers.length, 1)
  assert.equal(h.publishers[0].destroys, 1)
})

type Packet = { type: string; answers?: ServiceRecord[]; additionals?: ServiceRecord[]; questions?: Array<{ name: string; type: string }> }
const dnsPacket = createRequire(import.meta.url)('dns-packet') as { encode(packet: Packet): Buffer; decode(buffer: Buffer): Packet }

// Exercise the real Bonjour/multicast-dns stack against a controlled datagram
// transport. This catches regressions in probing, record registration, replies,
// asynchronous bind errors, and the dependency's private transport event bridge.
class Datagram extends EventEmitter {
  bound?: { port: number; address: string }
  outgoing?: string
  loopback = true
  closed = false
  membership?: string
  failMembership = false
  packets: Packet[] = []
  multicast?: (packet: Packet) => void

  bind(port: number, address: string, callback: () => void) {
    this.bound = { port, address }
    queueMicrotask(() => { this.emit('listening'); callback() })
  }
  addMembership(_group: string, address: string) {
    if (this.failMembership) throw new Error('Membership unavailable')
    this.membership = address
  }
  dropMembership() {}
  setMulticastInterface(address: string) { this.outgoing = address }
  setMulticastTTL() {}
  setMulticastLoopback(loopback: boolean) { this.loopback = loopback }
  send(buffer: Buffer, _offset: number, _length: number, port: number, address: string, callback: (error: Error | null) => void) {
    assert.equal(this.closed, false)
    assert.equal(port, 5353)
    assert.equal(address, '224.0.0.251')
    const packet = dnsPacket.decode(buffer)
    this.packets.push(packet)
    queueMicrotask(() => {
      callback(null)
      this.emit('sent', packet)
      this.multicast?.(packet)
      if (packet.type === 'response' && packet.answers?.some(r => r.type === 'PTR' && r.ttl > 0)) this.emit('advertised')
    })
  }
  close(callback?: () => void) { this.closed = true; callback?.() }
  receive(packet: Packet, address = '10.42.1.233') {
    this.emit('message', dnsPacket.encode(packet), { address, port: 5353, family: 'IPv4', size: 100 })
  }
}

test('real Bonjour publishes and answers with scoped addresses, then sends goodbyes and closes sockets', async t => {
  const sockets: Datagram[] = []
  t.mock.method(dgram, 'createSocket', () => { const socket = new Datagram(); sockets.push(socket); return socket })
  const adapter = createWindowsDiscoveryBonjour({
    getInterfaces: () => ({ USB: [ipv4('10.42.1.238')], 'Wi-Fi': [ipv4('192.168.1.23')] }),
    log: () => {}
  })
  t.after(() => adapter.destroy?.())
  const handle = adapter.publish(publication)
  await Promise.all(sockets.map(socket => once(socket, 'advertised', { signal: AbortSignal.timeout(3000) })))
  for (const socket of sockets) {
    assert.deepEqual(socket.bound, { port: 5353, address: '0.0.0.0' })
    assert.equal(socket.membership, socket.outgoing)
    assert.equal(socket.loopback, false)
    const announcement = socket.packets.find(p => p.type === 'response')!
    assert.deepEqual(announcement.answers!.filter(r => r.type === 'A').map(r => r.data), [socket.outgoing])
    assert.equal(announcement.answers!.some(r => r.type === 'AAAA'), false)
    const target = announcement.answers!.find(r => r.type === 'SRV')!.data.target
    assert.match(target, /\.local$/i)
    assert.equal(announcement.answers!.find(r => r.type === 'A')!.name, target)
    const replied = once(socket, 'sent')
    socket.receive({ type: 'query', questions: [{ name: '_astra-remote._tcp.local', type: 'PTR' }] })
    const [reply] = await replied as [Packet]
    assert.deepEqual(reply.additionals!.filter(r => r.type === 'A').map(r => r.data), [socket.outgoing])
    assert.equal(reply.additionals!.find(r => r.type === 'SRV')!.data.target, target)
    const resolved = once(socket, 'sent')
    socket.receive({ type: 'query', questions: [{ name: target, type: 'A' }] })
    const [addressReply] = await resolved as [Packet]
    assert.deepEqual(addressReply.answers!.filter(r => r.type === 'A').map(r => r.data), [socket.outgoing])
  }
  handle.stop()
  await new Promise(resolve => setImmediate(resolve))
  for (const socket of sockets) {
    assert.equal(socket.closed, true)
    assert.ok(socket.packets.at(-1)!.answers!.every(r => r.ttl === 0))
  }
})

test('a newly attached USB advertiser does not mistake a sibling advertiser for a name conflict', async t => {
  const sockets: Datagram[] = []
  t.mock.method(dgram, 'createSocket', () => {
    const socket = new Datagram()
    socket.multicast = packet => {
      // Windows applies IP_MULTICAST_LOOP to the receiving socket. With
      // loopback enabled, the established sibling would answer the new probe.
      for (const peer of sockets) if (!peer.closed && peer.loopback) peer.receive(packet, socket.outgoing)
    }
    sockets.push(socket)
    return socket
  })
  let interfaces = { 'Wi-Fi': [ipv4('192.168.1.23')] } as Record<string, NetworkInterfaceInfo[]>
  let refresh = () => {}
  const adapter = createWindowsDiscoveryBonjour({
    getInterfaces: () => interfaces,
    scheduleRefresh: callback => { refresh = callback; return () => {} },
    log: () => {}
  })
  t.after(() => adapter.destroy?.())
  adapter.publish(publication)
  await once(sockets[0], 'advertised', { signal: AbortSignal.timeout(3000) })
  interfaces = { ...interfaces, USB: [ipv4('10.42.1.238')] }
  refresh()
  await once(sockets[1], 'advertised', { signal: AbortSignal.timeout(3000) })
  assert.equal(sockets[0].closed, false)
  assert.equal(sockets[1].outgoing, '10.42.1.238')
  adapter.destroy?.()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(sockets.every(s => s.closed))
})

test('real transport warnings during socket setup and asynchronous bind errors are cleaned up and retried', async t => {
  const sockets: Datagram[] = []
  t.mock.method(dgram, 'createSocket', () => {
    const socket = new Datagram()
    socket.failMembership = sockets.length === 0
    sockets.push(socket)
    return socket
  })
  let refresh = () => {}
  const adapter = createWindowsDiscoveryBonjour({
    getInterfaces: () => ({ USB: [ipv4('10.42.1.238')] }),
    scheduleRefresh: callback => { refresh = callback; return () => {} },
    log: () => {}
  })
  t.after(() => adapter.destroy?.())
  adapter.publish(publication)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sockets[0].closed, true)
  refresh()
  await new Promise(resolve => setImmediate(resolve))
  assert.doesNotThrow(() => sockets[1].emit('error', Object.assign(new Error('Address in use'), { code: 'EADDRINUSE' })))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sockets[1].closed, true)
  refresh()
  assert.equal(sockets.length, 3)
  await new Promise(resolve => setImmediate(resolve))
  adapter.destroy?.()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(sockets.every(s => s.closed))
})
