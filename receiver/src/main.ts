import type {
  ParallaxIncomingPairRequest,
  PersistedParallaxSinkConnection
} from '../../src/types/parallax'
import { ParallaxAuthError } from '../../src/types/parallax'
import { ParallaxDiscoveryService } from '../../src/main/services/parallaxDiscovery'
import {
  ParallaxSinkListener,
  type ParallaxSinkListenerPairedInfo
} from '../../src/main/services/parallaxSinkListener'
import { ConfigStore } from './config'
import { createOutputBackend } from './output/backendFactory'
import { ParallaxSinkClient } from './sinkClient'
import { SinkSession } from './sinkSession'
import { WebStatusServer, type WebStatusState } from './webStatus'

// astra-receiver — standalone headless Parallax sink daemon ("parallax headless node").
// Reuses the app's protocol/crypto/discovery modules in place (src/types/parallax.ts +
// src/main/services/parallax{Security,SinkListener,Discovery}.ts); everything renderer-side is
// replaced by SinkSession + SinkPlayoutEngine on an ALSA (or null) output backend.
//
// Lifecycle: advertise over mDNS and accept pairing forever; whenever a credential exists, keep
// a connection to the host alive forever (boot retry loop here, in-session reconnect inside
// ParallaxSinkClient) — so a 24/7 node latches onto the host whenever it streams.

function log(message: string): void {
  console.log(`[astra-receiver] ${new Date().toISOString()} ${message}`)
}

function logError(message: string, error?: unknown): void {
  const detail = error instanceof Error ? error.message : error !== undefined ? String(error) : ''
  console.error(`[astra-receiver] ${new Date().toISOString()} ${message}${detail ? `: ${detail}` : ''}`)
}

const RELOCATE_TIMEOUT_MS = 3_000
const BOOT_RETRY_BASE_MS = 2_000
const BOOT_RETRY_MAX_MS = 20_000
const BOOT_RELOCATE_AFTER_ATTEMPTS = 3

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.())
}

async function main(): Promise<void> {
  const configStore = new ConfigStore()
  const config = configStore.get()
  log(`config at ${configStore.path}`)
  log(`endpoint UUID ${config.endpointUuid}`)

  const backend = createOutputBackend(config)
  log(`audio backend: ${backend.deviceLabel} @ ${backend.sampleRate} Hz, ${backend.channels}ch`)

  const session = new SinkSession(backend)
  session.setVolumePercent(config.volumePercent)
  session.start()

  const discovery = new ParallaxDiscoveryService()
  let incomingPair: ParallaxIncomingPairRequest | null = null
  let connectGeneration = 0

  const client = new ParallaxSinkClient({
    onEvent: (event) => session.handleEvent(event),
    onAudioChunk: (chunk) => session.handleAudioChunk(chunk),
    onStatus: (status) => {
      session.handleStatus(status)
    },
    onAuthRevoked: () => {
      log('host revoked this sink (401) — clearing credential; re-pair to reconnect')
      connectGeneration += 1
      configStore.setConnection(null)
    },
    onRelocate: async () => {
      const connection = configStore.get().connection
      const uuid = connection?.hostParallaxEndpointUuid
      if (!connection || !uuid) return null
      const resolved = await discovery.resolveHostByUuid(uuid, RELOCATE_TIMEOUT_MS)
      if (!resolved) return null
      log(`relocated host ${uuid} to ${resolved.baseUrl}`)
      configStore.setConnection({ ...connection, baseUrl: resolved.baseUrl })
      return resolved.baseUrl
    }
  })

  // Boot-path retry: the client's internal backoff only covers drops on an ESTABLISHED session
  // (mirrors the app, where main/index.ts owns the "sink boots while host is down" loop).
  async function startConnectLoop(): Promise<void> {
    connectGeneration += 1
    const generation = connectGeneration
    let attempts = 0
    while (generation === connectGeneration) {
      const connection = configStore.get().connection
      if (!connection) return
      try {
        session.attachClient(client, connection.sinkId)
        await client.connect({
          protocolVersion: 2,
          baseUrl: connection.baseUrl,
          sinkId: connection.sinkId,
          token: connection.token,
          hostCertificatePem: connection.hostCertificatePem,
          hostCertificateFingerprint: connection.hostCertificateFingerprint
        })
        configStore.setConnection({ ...configStore.get().connection ?? connection, lastConnectedAt: Date.now() })
        log(`connected to ${connection.hostName ?? connection.baseUrl}`)
        return
      } catch (error) {
        if (error instanceof ParallaxAuthError) return // credential already cleared
        attempts += 1
        if (attempts === 1) logError('host connect failed, retrying', error)
        if (attempts >= BOOT_RELOCATE_AFTER_ATTEMPTS && connection.hostParallaxEndpointUuid) {
          const resolved = await discovery.resolveHostByUuid(connection.hostParallaxEndpointUuid, RELOCATE_TIMEOUT_MS)
          const current = configStore.get().connection
          if (resolved && current && resolved.baseUrl !== current.baseUrl) {
            log(`relocated host to ${resolved.baseUrl}`)
            configStore.setConnection({ ...current, baseUrl: resolved.baseUrl })
          }
        }
        await sleep(Math.min(BOOT_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 5), BOOT_RETRY_MAX_MS))
      }
    }
  }

  const listener = new ParallaxSinkListener({
    getEndpointUuid: () => configStore.get().endpointUuid,
    getSinkName: () => configStore.get().sinkName,
    getHasPersistedConnection: () => configStore.get().connection !== null,
    onPaired: async (info: ParallaxSinkListenerPairedInfo) => {
      const connection: PersistedParallaxSinkConnection = {
        protocolVersion: 2,
        baseUrl: info.hostUrl,
        sinkId: info.sinkId,
        token: info.token,
        hostCertificatePem: info.hostCertificatePem,
        hostCertificateFingerprint: info.hostCertificateFingerprint,
        hostName: info.hostName,
        pairedAt: info.pairedAt,
        lastConnectedAt: null,
        hostParallaxEndpointUuid: info.hostParallaxEndpointUuid ?? undefined
      }
      configStore.setConnection(connection)
      log(`paired with ${info.hostName} (${info.hostUrl})`)
      void startConnectLoop()
    },
    onIncomingPairChange: (state) => {
      incomingPair = state
      if (state) {
        log(
          state.awaitingApproval
            ? `pair request from ${state.hostName}: awaiting approval on the web page`
            : `pair request from ${state.hostName}: PIN ${state.pin}`
        )
      }
    }
  })
  listener.on('error', (error) => logError('sink listener error', error))

  const web = new WebStatusServer({
    getState: (): WebStatusState => {
      const clientStatus = client.getStatus()
      const sessionInfo = session.getInfo()
      const current = configStore.get()
      return {
        sinkName: current.sinkName,
        endpointUuid: current.endpointUuid,
        paired: current.connection !== null,
        hostName: current.connection?.hostName ?? null,
        connected: clientStatus.connected,
        hostReachable: clientStatus.hostReachable,
        clockOffsetMs: clientStatus.clockOffsetMs,
        rttMs: clientStatus.rttMs,
        lastError: clientStatus.lastError,
        playbackState: sessionInfo.playbackState,
        streamTitle: sessionInfo.streamTitle,
        streamArtist: sessionInfo.streamArtist,
        assignedSinkName: sessionInfo.assignedSinkName,
        appliedAdvanceMs: sessionInfo.appliedAdvanceMs,
        volumePercent: current.volumePercent,
        outputDevice: backend.deviceLabel,
        incomingPair: incomingPair
          ? {
              pin: incomingPair.pin,
              hostName: incomingPair.hostName,
              awaitingApproval: incomingPair.awaitingApproval,
              expiresAtMs: incomingPair.expiresAtMs
            }
          : null,
        diagnostics: sessionInfo.diagnostics
      }
    },
    approvePair: () => listener.approvePending(),
    rejectPair: () => listener.cancelPending(),
    setName: (name) => {
      configStore.update({ sinkName: name })
      // Re-advertise so the wizard and paired hosts see the new name.
      discovery.startAdvertising({
        name,
        port: configStore.get().listenerPort,
        endpointUuid: configStore.get().endpointUuid,
        role: 'sink'
      })
    },
    setVolume: (percent) => {
      configStore.update({ volumePercent: percent })
      session.setVolumePercent(percent)
    },
    forgetHost: async () => {
      await client.forgetOnHost().catch(() => undefined)
      connectGeneration += 1
      await client.disconnect().catch(() => undefined)
      configStore.setConnection(null)
      log('forgot paired host')
    }
  })

  await listener.start(config.listenerPort)
  log(`pairing listener on :${config.listenerPort}`)
  await web.start(config.webPort)
  log(`status page on http://0.0.0.0:${config.webPort}/`)
  discovery.startAdvertising({
    name: config.sinkName,
    port: config.listenerPort,
    endpointUuid: config.endpointUuid,
    role: 'sink'
  })
  log(`advertising "_astra-zone._tcp" as "${config.sinkName}"`)

  if (configStore.get().connection) {
    void startConnectLoop()
  } else {
    log('not paired yet — open the status page and pair from Astra on the host')
  }

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log(`${signal} — shutting down`)
    connectGeneration += 1
    await client.disconnect().catch(() => undefined)
    await web.stop().catch(() => undefined)
    await listener.stop().catch(() => undefined)
    discovery.destroy()
    session.stop()
    backend.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  logError('fatal', error)
  process.exit(1)
})
