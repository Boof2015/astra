// Test-only loopback TCP link model. Every proxied connection shares one
// bottleneck per direction: serialization rate, a finite FIFO queue and one-way
// delay. Each direction of each connection also has a small TCP-like window:
// slow start from ten segments, restart after idle, and a bounded receiver window.
// It approximates Network Link Conditioner on loopback. It is not a packet-level
// TCP simulation: there is no loss, retransmission or ACK traffic on the wire.
// No system network settings change.
const net = require('node:net')

const MSS = 1448
const INITIAL_WINDOW = 10 * MSS
const MAX_WINDOW = 4 * 1024 * 1024
// Source bytes accepted per flow before pausing that socket's reads.
const PENDING_LIMIT = 64 * 1024
// Delivered bytes the destination has not consumed. Beyond this its window closes.
const RECEIVE_WINDOW = 256 * 1024

// Apple Network Link Conditioner bundle defaults (3G/Edge); LAN is a fast control.
const PROFILES = {
  '3g': { down: { kbps: 780, delayMs: 100 }, up: { kbps: 330, delayMs: 100 } },
  edge: { down: { kbps: 240, delayMs: 400 }, up: { kbps: 200, delayMs: 440 } },
  lan: { down: { kbps: 200_000, delayMs: 1 }, up: { kbps: 200_000, delayMs: 1 } }
}
exports.PROFILES = PROFILES

function resolveProfile(profile) {
  const value = typeof profile === 'string' ? PROFILES[profile] : profile
  if (!value?.down?.kbps || !value?.up?.kbps) throw new Error(`Unknown link profile: ${profile}`)
  return value
}

class Direction {
  constructor(name, queueBytes) {
    this.name = name
    this.queueBytes = queueBytes
    this.queue = []
    this.queued = 0
    this.busyUntil = 0
    this.lastDeliveryAt = 0
    this.deliveries = []
    this.acks = []
    this.flows = []
    this.next = 0
    this.stats = { bytes: 0, packets: 0, maxQueuedBytes: 0, queueDelayMs: [] }
  }
}

class Flow {
  constructor(link, direction, reverse, source, destination) {
    this.link = link
    this.direction = direction
    // Acknowledgements for this flow travel back over the opposite direction.
    this.reverse = reverse
    this.source = source
    this.destination = destination
    this.pending = []
    this.pendingBytes = 0
    this.inflight = 0
    this.cwnd = INITIAL_WINDOW
    this.lastActivity = performance.now()
    this.readyAt = 0
    this.sourceEnded = false
    this.finished = false
    this.paused = false
    this.closed = false
  }
  push(chunk) {
    if (this.closed) return
    this.pending.push(chunk)
    this.pendingBytes += chunk.length
    if (this.pendingBytes > PENDING_LIMIT && !this.paused) { this.paused = true; this.source.pause() }
    this.link.wake()
  }
  take(size) {
    let remaining = size
    const parts = []
    while (remaining > 0 && this.pending.length) {
      const head = this.pending[0]
      if (head.length <= remaining) { parts.push(head); this.pending.shift(); remaining -= head.length }
      else { parts.push(head.subarray(0, remaining)); this.pending[0] = head.subarray(remaining); remaining = 0 }
    }
    const bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts)
    this.pendingBytes -= bytes.length
    if (this.paused && this.pendingBytes < PENDING_LIMIT / 2) { this.paused = false; this.source.resume() }
    return bytes
  }
}

/** Starts proxies for `targets` ({ name: port }) that share one shaped link. */
exports.shapedLink = async function shapedLink(targets, options = {}) {
  const queueBytes = options.queueBytes ?? 50 * 1500
  const down = new Direction('down', queueBytes)
  const up = new Direction('up', queueBytes)
  const servers = []
  const sockets = new Set()
  const connections = []
  let profile = resolveProfile(options.profile ?? '3g')
  let profileName = typeof options.profile === 'string' ? options.profile : '3g'
  let timer = null
  let timerAt = Infinity
  let scheduled = []
  const began = performance.now()
  const changes = [{ atMs: 0, profile: profileName }]

  const link = {
    wake() { arm(performance.now()) }
  }
  const delayOf = direction => (direction === down ? profile.down : profile.up).delayMs
  const kbpsOf = direction => (direction === down ? profile.down : profile.up).kbps
  const rto = () => profile.down.delayMs + profile.up.delayMs + 200

  function arm(at) {
    if (at >= timerAt) return
    clearTimeout(timer)
    timerAt = at
    timer = setTimeout(tick, Math.max(0, at - performance.now()))
  }

  function fill(direction, now) {
    let progressed = true
    while (progressed) {
      progressed = false
      const flows = direction.flows
      for (let visited = 0; visited < flows.length; visited++) {
        const flow = flows[(direction.next + visited) % flows.length]
        if (flow.closed || !flow.pendingBytes || now < flow.readyAt) continue
        if (flow.destination.writableLength > RECEIVE_WINDOW) continue
        // RFC 2861 / Linux tcp_slow_start_after_idle: an idle sender restarts
        // from its initial window.
        if (!flow.inflight && now - flow.lastActivity > rto()) flow.cwnd = Math.min(flow.cwnd, INITIAL_WINDOW)
        const size = Math.min(MSS, flow.pendingBytes)
        if (flow.inflight && flow.inflight + size > flow.cwnd) continue
        if (direction.queued + size > direction.queueBytes) return
        const bytes = flow.take(size)
        flow.inflight += bytes.length
        flow.lastActivity = now
        direction.queue.push({ flow, bytes, at: now })
        direction.queued += bytes.length
        direction.stats.maxQueuedBytes = Math.max(direction.stats.maxQueuedBytes, direction.queued)
        direction.next = (direction.next + visited + 1) % flows.length
        progressed = true
        break
      }
    }
  }

  function transmit(direction, now) {
    // A packet starts when the link is free and it has been queued. Timers can
    // fire late, so catch up from busyUntil instead of restarting the link clock.
    while (direction.queue.length) {
      const packet = direction.queue[0]
      const start = Math.max(direction.busyUntil, packet.at)
      if (start > now) break
      direction.queue.shift()
      direction.queued -= packet.bytes.length
      direction.stats.queueDelayMs.push(start - packet.at)
      if (direction.stats.queueDelayMs.length > 20000) direction.stats.queueDelayMs.splice(0, 10000)
      direction.busyUntil = start + packet.bytes.length * 8 / kbpsOf(direction)
      // The link is FIFO: a shorter delay after a profile change must not let
      // later bytes overtake bytes still in flight (that would corrupt streams).
      direction.lastDeliveryAt = Math.max(direction.busyUntil + delayOf(direction), direction.lastDeliveryAt)
      direction.deliveries.push({ at: direction.lastDeliveryAt, packet })
      direction.stats.bytes += packet.bytes.length
      direction.stats.packets++
      fill(direction, now)
    }
  }

  function deliver(direction, now) {
    const due = []
    direction.deliveries = direction.deliveries.filter(item => item.at <= now ? (due.push(item), false) : true)
    for (const { packet } of due) {
      const flow = packet.flow
      if (!flow.closed && !flow.destination.destroyed) flow.destination.write(packet.bytes)
      // The acknowledgement returns over the reverse one-way delay.
      flow.reverse.acks.push({ at: now + delayOf(flow.reverse), flow, bytes: packet.bytes.length })
    }
  }

  function acknowledge(direction, now) {
    const due = []
    direction.acks = direction.acks.filter(item => item.at <= now ? (due.push(item), false) : true)
    for (const { flow, bytes } of due) {
      flow.inflight -= bytes
      flow.lastActivity = now
      // No loss is modelled, so the window only grows (slow start), up to a cap.
      flow.cwnd = Math.min(MAX_WINDOW, flow.cwnd + bytes)
    }
  }

  function finish(direction) {
    for (const flow of direction.flows) {
      if (flow.sourceEnded && !flow.finished && !flow.pendingBytes && !flow.inflight && !flow.closed) {
        flow.finished = true
        if (!flow.destination.destroyed) flow.destination.end()
      }
    }
  }

  function tick() {
    timer = null
    timerAt = Infinity
    const now = performance.now()
    for (const direction of [down, up]) { deliver(direction, now); acknowledge(direction, now) }
    for (const direction of [down, up]) { fill(direction, now); transmit(direction, now); finish(direction) }
    let next = Infinity
    for (const direction of [down, up]) {
      for (const item of direction.deliveries) next = Math.min(next, item.at)
      for (const item of direction.acks) next = Math.min(next, item.at)
      if (direction.queue.length) next = Math.min(next, Math.max(direction.busyUntil, direction.queue[0].at))
      for (const flow of direction.flows) if (flow.pendingBytes && flow.readyAt > now) next = Math.min(next, flow.readyAt)
    }
    if (next < Infinity) arm(Math.max(next, now + .05))
  }
  function remove(flow) {
    flow.closed = true
    for (const direction of [down, up]) {
      direction.flows = direction.flows.filter(value => value !== flow)
      direction.queue = direction.queue.filter(item => item.flow !== flow || (direction.queued -= item.bytes.length, false))
    }
  }

  for (const [name, port] of Object.entries(targets)) {
    const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true }, client => {
      const upstream = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true })
      sockets.add(client); sockets.add(upstream)
      const record = { target: name, openedAtMs: performance.now() - began, closedAtMs: null, upBytes: 0, downBytes: 0 }
      connections.push(record)
      const outbound = new Flow(link, up, down, client, upstream)
      const inbound = new Flow(link, down, up, upstream, client)
      // TCP's SYN / SYN-ACK costs one round trip before either side sends data.
      const ready = performance.now() + profile.down.delayMs + profile.up.delayMs
      outbound.readyAt = inbound.readyAt = ready
      up.flows.push(outbound); down.flows.push(inbound)
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        record.closedAtMs = performance.now() - began
        remove(outbound); remove(inbound)
        client.destroy(); upstream.destroy()
        sockets.delete(client); sockets.delete(upstream)
      }
      client.on('data', chunk => { record.upBytes += chunk.length; outbound.push(chunk) })
      upstream.on('data', chunk => { record.downBytes += chunk.length; inbound.push(chunk) })
      client.on('end', () => { outbound.sourceEnded = true; link.wake() })
      upstream.on('end', () => { inbound.sourceEnded = true; link.wake() })
      client.on('drain', () => link.wake())
      upstream.on('drain', () => link.wake())
      client.on('error', close); upstream.on('error', close)
      client.on('close', close); upstream.on('close', close)
      upstream.once('connect', () => client.resume())
      arm(ready)
    })
    server.listen(0, '127.0.0.1')
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    servers.push({ name, server, port: server.address().port })
  }

  const percentile = (values, p) => {
    if (!values.length) return null
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  }
  return {
    ports: Object.fromEntries(servers.map(value => [value.name, value.port])),
    get profile() { return profileName },
    setProfile(next) {
      profile = resolveProfile(next)
      profileName = typeof next === 'string' ? next : 'custom'
      changes.push({ atMs: performance.now() - began, profile: profileName })
      link.wake()
    },
    /** Applies [{ atMs, profile }] relative to now. */
    schedule(steps) {
      for (const step of steps) scheduled.push(setTimeout(() => this.setProfile(step.profile), step.atMs))
    },
    /** Starts a new measurement window. Link state and open connections are kept. */
    resetStats() {
      for (const value of [down, up]) value.stats = { bytes: 0, packets: 0, maxQueuedBytes: 0, queueDelayMs: [] }
      connections.length = 0
      changes.length = 0
      changes.push({ atMs: performance.now() - began, profile: profileName })
    },
    stats() {
      const direction = value => ({ bytes: value.stats.bytes, packets: value.stats.packets,
        maxQueuedBytes: value.stats.maxQueuedBytes,
        queueDelayMs: { p50: percentile(value.stats.queueDelayMs, .5), p95: percentile(value.stats.queueDelayMs, .95),
          max: percentile(value.stats.queueDelayMs, 1) } })
      return { queueBytes, changes, down: direction(down), up: direction(up),
        connections: connections.map(value => ({ ...value })) }
    },
    async close() {
      for (const value of scheduled) clearTimeout(value)
      clearTimeout(timer)
      for (const socket of sockets) socket.destroy()
      await Promise.all(servers.map(value => new Promise(resolve => value.server.close(resolve))))
    }
  }
}
