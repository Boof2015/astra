import { execFile } from 'child_process'
import { realpathSync } from 'fs'
import { basename, dirname } from 'path'
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
import { createCecController } from './cecController'
import { ConfigStore } from './config'
import { createNetworkSetup } from './networkSetup'
import { createOutputBackend } from './output/backendFactory'
import { listAlsaDevices } from './output/alsaDevices'
import { createOutputDeviceSetter } from './output/deviceSelection'
import { ParallaxSinkClient } from './sinkClient'
import { SinkSession } from './sinkSession'
import { createShutdownCoordinator } from './shutdown'
import { createSystemdNotifier } from './systemdNotify'
import { WebStatusServer, resolveReceiverStatusLabel, type WebStatusState } from './webStatus'

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

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message || '').trim() || 'command failed'))
      else resolve(stdout)
    })
  })
}

// System timezone via timedatectl (the image's polkit rule authorizes the service user). The
// list is static per boot; cache it. Empty on non-systemd machines — the web UI hides the
// picker then.
let timezonesCache: string[] | null = null
async function listTimezones(): Promise<string[]> {
  if (timezonesCache) return timezonesCache
  try {
    const stdout = await runCommand('timedatectl', ['list-timezones', '--no-pager'])
    timezonesCache = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    timezonesCache = []
  }
  return timezonesCache
}

// Grace period between answering POST /api/output and restarting onto the new device, so the
// HTTP response reaches the page before the listener goes away.
const OUTPUT_CHANGE_RESTART_DELAY_MS = 750

// Installed release tag, derived from where this script actually lives: the appliance/installer
// layout runs /opt/astra-receiver/current/astra-receiver.mjs with current → releases/<tag>, so
// the resolved parent directory IS the version stamp (same invariant update.sh relies on).
function resolveInstalledVersion(): string {
  try {
    const dir = basename(dirname(realpathSync(process.argv[1] ?? '')))
    if (dir.startsWith('receiver-v')) return dir.slice('receiver-'.length)
  } catch { /* dev run from source */ }
  return 'dev'
}

async function main(): Promise<void> {
  const notifier = createSystemdNotifier({ log: (message) => logError(message) })
  const configStore = new ConfigStore()
  const config = configStore.get()
  const installedVersion = resolveInstalledVersion()
  log(`config at ${configStore.path}`)
  log(`endpoint UUID ${config.endpointUuid}`)

  const audio = createOutputBackend(config, { log })
  const backend = audio.backend
  log(`audio backend: ${backend.deviceLabel} @ ${backend.sampleRate} Hz, ${backend.channels}ch`)

  // Captive-portal Wi-Fi onboarding (Parallax OS): no-op unless apSetup is set (and nmcli/
  // NetworkManager exist, which only the appliance image guarantees).
  const networkSetup = createNetworkSetup({
    enabled: config.apSetup && process.platform === 'linux',
    log
  })

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
    softwareVersion: installedVersion,
    onDiagnostic: (diagnostic) => {
      logError('Parallax join validation failed', JSON.stringify(diagnostic))
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

  // HDMI-CEC TV control (Parallax OS TV mode; inert unless cecControl is set and /dev/cec*
  // exists). Driven by a 1 Hz playback/connection poll; the controller debounces transitions.
  // Created before the web server: getState exposes it, and settings changes apply live. The
  // web server is created after, so remote keys route through a late-bound forwarder.
  let lastRemoteKey: { key: string | null; raw: string; atMs: number } | null = null
  let forwardRemoteKey: (key: string | null, raw: string) => void = () => undefined
  const cec = createCecController({
    settings: {
      enabled: config.cecControl,
      wakeOn: config.cecWakeOn,
      switchInput: config.cecSwitchInput,
      standbyMinutes: config.cecStandbyMinutes
    },
    onRemoteKey: (key, raw) => {
      lastRemoteKey = { key, raw, atMs: Date.now() }
      forwardRemoteKey(key, raw)
    },
    log
  })
  const cecPollTimer = setInterval(() => {
    cec.notifyPlayback(session.getInfo().playbackState === 'playing')
    cec.notifyConnection(client.getStatus().connected)
  }, 1_000)
  cecPollTimer.unref?.()

  // On-demand update runs: after kicking the updater unit, mirror its systemd ActiveState into
  // status as `updating` so both UIs can show an honest "hold on" instead of instant success.
  // (Reading unit state needs no polkit; if an update is found the updater restarts us and the
  // fresh process reports updating=false — the pages detect completion by the version change.)
  let updateRunActive = false
  let updateWatchTimer: ReturnType<typeof setInterval> | null = null
  const stopUpdateWatch = (): void => {
    updateRunActive = false
    if (updateWatchTimer) {
      clearInterval(updateWatchTimer)
      updateWatchTimer = null
    }
  }
  const watchUpdateUnit = (): void => {
    if (updateWatchTimer) return
    updateRunActive = true
    const startedAt = Date.now()
    updateWatchTimer = setInterval(() => {
      if (Date.now() - startedAt > 15 * 60_000) {
        stopUpdateWatch()
        return
      }
      void runCommand('systemctl', ['show', '-p', 'ActiveState', '--value', 'astra-receiver-update.service'])
        .then((stdout) => {
          const state = stdout.trim()
          if (state !== 'active' && state !== 'activating') stopUpdateWatch()
        })
        .catch(() => stopUpdateWatch())
    }, 2_000)
    updateWatchTimer.unref?.()
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
      const connectionState = {
        paired: current.connection !== null,
        connected: clientStatus.connected,
        hostReachable: clientStatus.hostReachable,
        playbackEnabled: clientStatus.playbackEnabled
      }
      return {
        sinkName: current.sinkName,
        endpointUuid: current.endpointUuid,
        paired: current.connection !== null,
        hostName: current.connection?.hostName ?? null,
        connected: clientStatus.connected,
        playbackEnabled: clientStatus.playbackEnabled,
        statusLabel: resolveReceiverStatusLabel(connectionState),
        hostReachable: clientStatus.hostReachable,
        clockOffsetMs: clientStatus.clockOffsetMs,
        rttMs: clientStatus.rttMs,
        lastError: clientStatus.lastError,
        playbackState: sessionInfo.playbackState,
        streamTitle: sessionInfo.streamTitle,
        streamArtist: sessionInfo.streamArtist,
        streamAlbum: sessionInfo.streamAlbum,
        position: sessionInfo.position,
        assignedSinkName: sessionInfo.assignedSinkName,
        appliedAdvanceMs: sessionInfo.appliedAdvanceMs,
        volumePercent: current.volumePercent,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        clockFormat: current.clockFormat,
        version: installedVersion,
        updating: updateRunActive,
        transportSupported: client.getControlSupported(),
        cec: {
          available: cec.available,
          control: current.cecControl,
          wakeOn: current.cecWakeOn,
          switchInput: current.cecSwitchInput,
          standbyMinutes: current.cecStandbyMinutes,
          lastKey: lastRemoteKey ? { raw: lastRemoteKey.raw, atMs: lastRemoteKey.atMs } : null
        },
        artworkId: client.getActiveArtwork()?.streamId ?? null,
        audioAvailable: audio.audioAvailable,
        audioError: audio.audioError,
        outputDevice: backend.deviceLabel,
        configuredDevice: current.audioDevice,
        audioDevices: listAlsaDevices(),
        incomingPair: incomingPair
          ? {
              pin: incomingPair.pin,
              hostName: incomingPair.hostName,
              awaitingApproval: incomingPair.awaitingApproval,
              expiresAtMs: incomingPair.expiresAtMs
            }
          : null,
        setup: networkSetup.enabled
          ? { ...networkSetup.getState(), apSsid: networkSetup.apSsid }
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
    setOutputDevice: createOutputDeviceSetter({
      getConfiguredDevice: () => configStore.get().audioDevice,
      listDevices: listAlsaDevices,
      persistDevice: (device) => { configStore.update({ audioDevice: device }) },
      log,
      shouldRestartCurrentDevice: () => (
        config.audioBackend === 'alsa' && backend.deviceId !== configStore.get().audioDevice
      ),
      // The ALSA handle and the frames-written emission clock can't be swapped live; a clean
      // exit under Restart=always is the reliable reopen path. Delay so the response flushes.
      scheduleRestart: () => {
        setTimeout(() => void shutdown('output device change'), OUTPUT_CHANGE_RESTART_DELAY_MS)
      }
    }),
    getArtwork: () => {
      const artwork = client.getActiveArtwork()
      return artwork ? { contentType: artwork.contentType, bytes: artwork.bytes } : null
    },
    getSetupNetworks: () => networkSetup.scanNetworks(),
    applySetupCredentials: (ssid, password) => networkSetup.applyCredentials(ssid, password),
    getTimezones: () => listTimezones(),
    setTimezone: async (timezone) => {
      if (!(await listTimezones()).includes(timezone)) return false
      try {
        await runCommand('timedatectl', ['set-timezone', timezone])
      } catch (error) {
        logError('failed to set timezone', error)
        return false
      }
      // Node caches the process timezone at startup — restart so status (and through it every
      // clock on the display pages) reports the new zone.
      log(`timezone set to ${timezone} — restarting to apply`)
      setTimeout(() => void shutdown('timezone change'), OUTPUT_CHANGE_RESTART_DELAY_MS)
      return true
    },
    setCecSettings: (settings) => {
      configStore.update({
        cecControl: settings.control,
        cecWakeOn: settings.wakeOn,
        cecSwitchInput: settings.switchInput,
        cecStandbyMinutes: settings.standbyMinutes
      })
      cec.updateSettings({
        enabled: settings.control,
        wakeOn: settings.wakeOn,
        switchInput: settings.switchInput,
        standbyMinutes: settings.standbyMinutes
      })
      log(`CEC settings updated: control ${settings.control ? 'on' : 'off'}, wake on ${settings.wakeOn}, `
        + `switch input ${settings.switchInput ? 'on' : 'off'}, standby ${settings.standbyMinutes || 'never'}`)
    },
    setClockFormat: (format) => {
      configStore.update({ clockFormat: format })
    },
    sendTransport: (command) => client.sendControl(command),
    systemAction: async (action) => {
      if (action === 'restart') {
        log('restart requested from the web page')
        setTimeout(() => void shutdown('web restart'), OUTPUT_CHANGE_RESTART_DELAY_MS)
        return { ok: true }
      }
      if (action === 'reboot') {
        log('reboot requested from the web page')
        try {
          await runCommand('systemctl', ['reboot'])
          return { ok: true }
        } catch (error) {
          logError('reboot failed', error)
          return { ok: false, error: 'Reboot is not permitted on this system.' }
        }
      }
      if (action === 'reset-wifi') {
        try {
          const removed = await networkSetup.forgetWifiConnections()
          log(`reset-wifi requested from the web page (${removed} profile(s) removed)`)
          return { ok: true }
        } catch (error) {
          logError('reset-wifi failed', error)
          return { ok: false, error: 'Could not remove the saved Wi-Fi networks.' }
        }
      }
      if (action === 'factory-reset') {
        log('FACTORY RESET requested — clearing pairing, identity, settings, and Wi-Fi')
        // Best-effort courtesy: retire our sink id on the host so it doesn't linger there.
        await client.forgetOnHost().catch(() => undefined)
        connectGeneration += 1
        await networkSetup.forgetWifiConnections().catch(() => undefined)
        try {
          configStore.factoryReset()
        } catch (error) {
          logError('factory reset could not rewrite the config file', error)
          return { ok: false, error: 'Could not clear the configuration.' }
        }
        // Clean exit; the service restart boots as a factory-fresh device (new endpoint UUID,
        // no pairing, user settings back to defaults) while the image's baked provisioning
        // (port 80, apSetup, cecControl) survives — the setup AP re-raises as on first boot.
        setTimeout(() => void shutdown('factory reset'), OUTPUT_CHANGE_RESTART_DELAY_MS)
        return { ok: true }
      }
      // 'update': kick the image's updater unit without waiting for it (a oneshot start blocks
      // until the unit finishes otherwise). If an update is found, update.sh restarts us.
      try {
        await runCommand('systemctl', ['start', '--no-block', 'astra-receiver-update.service'])
        watchUpdateUnit()
        return { ok: true }
      } catch (error) {
        logError('update check failed to start', error)
        return { ok: false, error: 'On-demand updates need the Parallax OS update service.' }
      }
    },
    forgetHost: async () => {
      await client.forgetOnHost().catch(() => undefined)
      connectGeneration += 1
      await client.disconnect().catch(() => undefined)
      configStore.setConnection(null)
      log('forgot paired host')
    }
  })

  forwardRemoteKey = (key, raw) => web.pushRemoteKey(key, raw)

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

  // The daemon is now genuinely serving (pairing listener, web page, mDNS). Under a Type=notify
  // unit this releases systemd's start wait and arms the WatchdogSec keepalive; everywhere else
  // the notifier is a no-op.
  notifier.ready()
  notifier.startWatchdog()
  networkSetup.start()

  if (configStore.get().connection) {
    void startConnectLoop()
  } else {
    log('not paired yet — open the status page and pair from Astra on the host')
  }

  const shutdown = createShutdownCoordinator({
    log,
    exit: (code) => process.exit(code),
    prepare: [
      { name: 'systemd stopping notification', run: () => notifier.stopping() },
      { name: 'systemd watchdog', run: () => notifier.stopWatchdog() },
      { name: 'CEC poll', run: () => clearInterval(cecPollTimer) },
      { name: 'CEC controller', run: () => cec.stop() },
      { name: 'update watcher', run: stopUpdateWatch },
      { name: 'network setup', run: () => networkSetup.stop() },
      { name: 'host reconnect loop', run: () => { connectGeneration += 1 } }
    ],
    cleanup: [
      { name: 'host client', run: () => client.disconnect() },
      { name: 'web server', run: () => web.stop() },
      { name: 'pairing listener', run: () => listener.stop() }
    ],
    finalizers: [
      { name: 'discovery', run: () => discovery.destroy() },
      { name: 'session', run: () => session.stop() },
      { name: 'audio backend', run: () => backend.close() }
    ]
  })
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  logError('fatal', error)
  process.exit(1)
})
