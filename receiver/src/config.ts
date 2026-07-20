import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir, hostname } from 'os'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import type { PersistedParallaxSinkConnection } from '../../src/types/parallax'
import type { CecWakeOn } from './cecController'

/** Clock rendering on the display pages: locale default, or forced 12/24-hour. */
export type ClockFormat = 'auto' | '12' | '24'

// JSON-file replacement for the app's better-sqlite3 app-meta persistence. One file holds the
// durable identity (endpoint UUID), user-facing settings, and the single §14.1.2 paired-host
// credential slot — the same `PersistedParallaxSinkConnection` shape the app stores.

export interface ReceiverConfig {
  endpointUuid: string
  sinkName: string
  /** ALSA device string ('default', 'hw:0,0', …). Ignored by the null backend. */
  audioDevice: string
  /** 'alsa' on the Pi; 'null' for dev machines / tests. */
  audioBackend: 'alsa' | 'null'
  /** Local output volume 0–100. Applied on top of host-sent normalization gain. */
  volumePercent: number
  /** Port for the pairing listener (mDNS-advertised). */
  listenerPort: number
  /** Port for the local status/pairing web page. */
  webPort: number
  /** HDMI-CEC TV control (Parallax OS TV mode): wake the TV when a stream starts playing,
   *  standby after the idle timeout. Needs /dev/cec0 + cec-ctl (v4l-utils). */
  cecControl: boolean
  /** What turns the TV on: playback starting, the host connecting (which also wakes on
   *  playback), or nothing. */
  cecWakeOn: CecWakeOn
  /** Claim the TV's input (CEC active source) when waking; off = power control only. */
  cecSwitchInput: boolean
  /** Minutes of not-playing before the TV is sent to standby; 0 = never. */
  cecStandbyMinutes: number
  /** Clock format on the display pages. */
  clockFormat: ClockFormat
  /** Captive-portal Wi-Fi onboarding (Parallax OS): raise an open "Parallax-Setup" hotspot when
   *  the device has no network, serve the setup portal on the web port. Needs NetworkManager
   *  plus the image's polkit + dnsmasq drop-ins. */
  apSetup: boolean
  connection: PersistedParallaxSinkConnection | null
}

export const DEFAULT_WEB_PORT = 38405

export function defaultConfigPath(): string {
  const override = process.env.ASTRA_RECEIVER_CONFIG?.trim()
  if (override) return override
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  const base = xdg || join(homedir(), '.config')
  return join(base, 'astra-receiver', 'config.json')
}

function defaults(): ReceiverConfig {
  return {
    endpointUuid: randomUUID(),
    sinkName: hostname() || 'Astra Receiver',
    audioDevice: 'default',
    audioBackend: process.platform === 'linux' ? 'alsa' : 'null',
    volumePercent: 100,
    listenerPort: 38404,
    webPort: DEFAULT_WEB_PORT,
    cecControl: false,
    cecWakeOn: 'play',
    cecSwitchInput: true,
    cecStandbyMinutes: 10,
    clockFormat: 'auto',
    apSetup: false,
    connection: null
  }
}

function sanitizeConnection(value: unknown): PersistedParallaxSinkConnection | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<PersistedParallaxSinkConnection>
  if (record.protocolVersion !== 2) return null
  if (
    typeof record.baseUrl !== 'string' || !record.baseUrl.trim()
    || typeof record.sinkId !== 'string' || !record.sinkId.trim()
    || typeof record.token !== 'string' || !record.token.trim()
    || typeof record.hostCertificatePem !== 'string' || !record.hostCertificatePem.trim()
    || typeof record.hostCertificateFingerprint !== 'string' || !record.hostCertificateFingerprint.trim()
  ) return null
  return {
    protocolVersion: 2,
    baseUrl: record.baseUrl.trim(),
    sinkId: record.sinkId.trim(),
    token: record.token.trim(),
    hostCertificatePem: record.hostCertificatePem,
    hostCertificateFingerprint: record.hostCertificateFingerprint.trim(),
    hostName: typeof record.hostName === 'string' ? record.hostName : null,
    pairedAt: Number.isFinite(record.pairedAt) ? Number(record.pairedAt) : Date.now(),
    lastConnectedAt: Number.isFinite(record.lastConnectedAt as number) ? Number(record.lastConnectedAt) : null,
    hostParallaxEndpointUuid: typeof record.hostParallaxEndpointUuid === 'string'
      ? record.hostParallaxEndpointUuid
      : undefined
  }
}

// Floor is 1, not 1024: the Parallax OS appliance serves the status page on :80 (the unit grants
// CAP_NET_BIND_SERVICE); privileged-port policy belongs to systemd, not config validation.
function sanitizePort(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback
}

export class ConfigStore {
  readonly path: string
  private config: ReceiverConfig

  constructor(path: string = defaultConfigPath()) {
    this.path = path
    this.config = this.load()
  }

  private load(): ReceiverConfig {
    const base = defaults()
    let raw: unknown = null
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      // Missing or corrupt file — start from defaults and persist so the UUID sticks.
      this.persist(base)
      return base
    }
    const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const merged: ReceiverConfig = {
      endpointUuid: typeof record.endpointUuid === 'string' && record.endpointUuid.trim()
        ? record.endpointUuid.trim()
        : base.endpointUuid,
      sinkName: typeof record.sinkName === 'string' && record.sinkName.trim()
        ? record.sinkName.trim().slice(0, 80)
        : base.sinkName,
      audioDevice: typeof record.audioDevice === 'string' && record.audioDevice.trim()
        ? record.audioDevice.trim()
        : base.audioDevice,
      audioBackend: record.audioBackend === 'alsa' || record.audioBackend === 'null'
        ? record.audioBackend
        : base.audioBackend,
      volumePercent: Number.isFinite(record.volumePercent as number)
        ? Math.max(0, Math.min(100, Number(record.volumePercent)))
        : base.volumePercent,
      listenerPort: sanitizePort(record.listenerPort, base.listenerPort),
      webPort: sanitizePort(record.webPort, base.webPort),
      cecControl: record.cecControl === true,
      cecWakeOn: record.cecWakeOn === 'play' || record.cecWakeOn === 'connect' || record.cecWakeOn === 'off'
        ? record.cecWakeOn
        : base.cecWakeOn,
      // Default true — only an explicit false opts out of input switching.
      cecSwitchInput: record.cecSwitchInput !== false,
      cecStandbyMinutes: Number.isInteger(record.cecStandbyMinutes as number)
        && Number(record.cecStandbyMinutes) >= 0 && Number(record.cecStandbyMinutes) <= 720
        ? Number(record.cecStandbyMinutes)
        : base.cecStandbyMinutes,
      clockFormat: record.clockFormat === '12' || record.clockFormat === '24'
        ? record.clockFormat
        : base.clockFormat,
      apSetup: record.apSetup === true,
      connection: sanitizeConnection(record.connection)
    }
    // Re-persist when the file was missing fields (first run after an upgrade) so the UUID and
    // defaults are durable before pairing advertises them.
    if (typeof record.endpointUuid !== 'string' || !record.endpointUuid.trim()) {
      this.persist(merged)
    }
    return merged
  }

  private persist(config: ReceiverConfig): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmpPath = `${this.path}.tmp`
    writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmpPath, this.path)
  }

  get(): ReceiverConfig {
    return this.config
  }

  update(patch: Partial<ReceiverConfig>): ReceiverConfig {
    this.config = { ...this.config, ...patch }
    this.persist(this.config)
    return this.config
  }

  setConnection(connection: PersistedParallaxSinkConnection | null): void {
    this.update({ connection })
  }

  // "As shipped" reset. Deliberately NOT a file wipe: the Parallax OS image bakes provisioning
  // into this same file (webPort 80, apSetup, cecControl, alsa backend), and losing apSetup
  // would leave a reset appliance with no setup hotspot — unrecoverable without SSH. So the
  // deployment-shaped fields survive and everything user-owned resets: fresh endpoint UUID,
  // no pairing, default name/output/volume/clock/CEC behavior.
  factoryReset(): ReceiverConfig {
    const fresh = defaults()
    this.config = {
      ...fresh,
      audioBackend: this.config.audioBackend,
      webPort: this.config.webPort,
      listenerPort: this.config.listenerPort,
      apSetup: this.config.apSetup,
      cecControl: this.config.cecControl
    }
    this.persist(this.config)
    return this.config
  }
}
