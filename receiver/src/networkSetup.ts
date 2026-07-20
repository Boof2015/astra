import { execFile } from 'child_process'

// Captive-portal Wi-Fi onboarding for Parallax OS. When the device has had no LAN connection
// (ethernet or Wi-Fi) for ~2 minutes, raise an OPEN hotspot ("Parallax-Setup") via
// NetworkManager; the web server serves the portal and calls applyCredentials() with what the
// user picked. Applying drops the AP first (a Pi radio can't reliably host and join at once),
// so the portal warns the phone before it loses the network; on failure the AP comes back with
// the error stored for the rejoining phone to see.
//
// Everything goes through nmcli. The daemon's service user is allowed to drive NetworkManager
// by the image's polkit rule; captive-portal DNS ("every name resolves to me") comes from the
// image's dnsmasq-shared.d drop-in. Off (enabled: false) everywhere except the appliance.

export interface WifiNetwork {
  ssid: string
  signal: number
  secured: boolean
}

export interface NetworkSetupState {
  apActive: boolean
  connecting: boolean
  lastError: string | null
  /** Seconds until the setup AP raises, while offline and counting down; null otherwise. */
  apEtaSeconds: number | null
}

export interface NetworkSetupOptions {
  enabled: boolean
  apSsid?: string
  exec?: (command: string, args: string[], timeoutMs?: number) => Promise<{ stdout: string }>
  log?: (message: string) => void
  checkIntervalMs?: number
  offlineChecksBeforeAp?: number
}

export interface NetworkSetup {
  readonly enabled: boolean
  readonly apSsid: string
  start(): void
  stop(): void
  getState(): NetworkSetupState
  scanNetworks(): Promise<WifiNetwork[]>
  /** Accepts the credentials for an async apply. False = busy or feature off. */
  applyCredentials(ssid: string, password: string): boolean
  /** Deletes every saved Wi-Fi profile (settings "Reset Wi-Fi" / factory reset) — the
   *  connectivity checks then re-raise the setup AP on the first-boot fast path. Returns the
   *  number of profiles removed; 0 when the feature is off. */
  forgetWifiConnections(): Promise<number>
  /** One connectivity-check cycle; exposed for tests (start() runs it on an interval). */
  tick(): Promise<void>
}

export const SETUP_AP_CONNECTION = 'parallax-setup'
const DEFAULT_AP_SSID = 'Parallax-Setup'
const CONNECT_TIMEOUT_MS = 60_000

// nmcli -t escapes ':' and '\' with a backslash.
export function parseNmcliTerse(line: string): string[] {
  const fields: string[] = []
  let current = ''
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '\\' && i + 1 < line.length) {
      current += line[i + 1]
      i += 1
    } else if (ch === ':') {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

export function parseWifiList(stdout: string): WifiNetwork[] {
  const bySsid = new Map<string, WifiNetwork>()
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const [ssid, signalRaw, security] = parseNmcliTerse(line)
    if (!ssid) continue
    const signal = Number(signalRaw) || 0
    const secured = Boolean(security && security.trim() && security.trim() !== '--')
    const existing = bySsid.get(ssid)
    if (!existing || existing.signal < signal) {
      bySsid.set(ssid, { ssid, signal, secured })
    }
  }
  return [...bySsid.values()].sort((a, b) => b.signal - a.signal).slice(0, 30)
}

function defaultExec(command: string, args: string[], timeoutMs = 15_000): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || error.message || '').trim()
        reject(new Error(detail || 'command failed'))
      } else {
        resolve({ stdout })
      }
    })
  })
}

export function createNetworkSetup(options: NetworkSetupOptions): NetworkSetup {
  const apSsid = options.apSsid ?? DEFAULT_AP_SSID
  const log = options.log ?? ((message) => console.log(`[astra-receiver] ${message}`))
  const disabled: NetworkSetup = {
    enabled: false,
    apSsid,
    start: () => undefined,
    stop: () => undefined,
    getState: () => ({ apActive: false, connecting: false, lastError: null, apEtaSeconds: null }),
    scanNetworks: async () => [],
    applyCredentials: () => false,
    forgetWifiConnections: async () => 0,
    tick: async () => undefined
  }
  if (!options.enabled) return disabled

  const exec = options.exec ?? defaultExec
  const checkIntervalMs = options.checkIntervalMs ?? 15_000
  const offlineThreshold = options.offlineChecksBeforeAp ?? 8

  let apActive = false
  let connecting = false
  let lastError: string | null = null
  let offlineChecks = 0
  let cachedScan: WifiNetwork[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  let stopped = false
  let lastTickAtMs = 0
  // null until the first offline check looks it up. A device with NO saved Wi-Fi profiles is a
  // first boot — raise the AP fast (~30 s). With profiles, hold the full threshold so a router
  // blip doesn't flip a provisioned speaker into setup mode.
  let hasWifiProfiles: boolean | null = null

  const nmcli = (args: string[], timeoutMs?: number): Promise<{ stdout: string }> =>
    exec('nmcli', args, timeoutMs)

  const wifiDevice = async (): Promise<string | null> => {
    const { stdout } = await nmcli(['-t', '-f', 'DEVICE,TYPE', 'device'])
    for (const line of stdout.split('\n')) {
      const [device, type] = parseNmcliTerse(line)
      if (type === 'wifi' && device) return device
    }
    return null
  }

  // "Online" for an appliance is LAN presence, NOT internet: nmcli's connectivity check would
  // flag an offline-but-working music network. While our own AP is up the wifi device counts
  // as connected, so callers gate on apActive first.
  const hasLanConnection = async (): Promise<boolean> => {
    const { stdout } = await nmcli(['-t', '-f', 'DEVICE,TYPE,STATE', 'device'])
    for (const line of stdout.split('\n')) {
      const [device, type, state] = parseNmcliTerse(line)
      if (!device || (type !== 'ethernet' && type !== 'wifi')) continue
      if (state === 'connected') return true
    }
    return false
  }

  const liveScan = async (): Promise<WifiNetwork[]> => {
    const { stdout } = await nmcli(
      ['-t', '-f', 'SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'yes'],
      30_000
    )
    return parseWifiList(stdout)
  }

  const raiseAp = async (): Promise<void> => {
    // Pi OS ships Wi-Fi soft-blocked until a regulatory domain is set; the image bakes the
    // domain (WPA_COUNTRY), and this defensive enable clears any residual soft-block through
    // NetworkManager's own path (no root needed, unlike rfkill).
    await nmcli(['radio', 'wifi', 'on']).catch(() => undefined)
    // Scan BEFORE hosting: the Pi radio can't reliably scan while it runs the AP, so the
    // portal serves this cached list.
    try {
      cachedScan = await liveScan()
    } catch {
      // keep whatever we had
    }
    const device = await wifiDevice()
    if (!device) {
      log('AP setup: no Wi-Fi device found — cannot raise the setup hotspot.')
      return
    }
    await nmcli(['connection', 'delete', SETUP_AP_CONNECTION]).catch(() => undefined)
    await nmcli([
      'connection', 'add', 'type', 'wifi', 'ifname', device,
      'con-name', SETUP_AP_CONNECTION, 'autoconnect', 'no', 'ssid', apSsid,
      '802-11-wireless.mode', 'ap', 'ipv4.method', 'shared', 'ipv6.method', 'disabled'
    ])
    await nmcli(['connection', 'up', SETUP_AP_CONNECTION], 30_000)
    apActive = true
    log(`AP setup: hosting open network "${apSsid}" — portal on http://10.42.0.1/setup`)
  }

  const dropAp = async (): Promise<void> => {
    await nmcli(['connection', 'down', SETUP_AP_CONNECTION]).catch(() => undefined)
    await nmcli(['connection', 'delete', SETUP_AP_CONNECTION]).catch(() => undefined)
    apActive = false
  }

  const applyAsync = async (ssid: string, password: string): Promise<void> => {
    log(`AP setup: applying credentials for "${ssid}"`)
    try {
      await dropAp()
      const device = await wifiDevice()
      // A failed earlier attempt leaves a broken profile that would shadow this one.
      await nmcli(['connection', 'delete', 'id', ssid]).catch(() => undefined)
      const args = ['device', 'wifi', 'connect', ssid]
      if (password) args.push('password', password)
      if (device) args.push('ifname', device)
      await nmcli(args, CONNECT_TIMEOUT_MS)
      lastError = null
      offlineChecks = 0
      log(`AP setup: joined "${ssid}".`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      lastError = /secrets|password|802-1x|auth/i.test(detail)
        ? `Could not join "${ssid}" — check the password.`
        : `Could not join "${ssid}": ${detail}`
      log(`AP setup: ${lastError}`)
      await nmcli(['connection', 'delete', 'id', ssid]).catch(() => undefined)
      if (!stopped) {
        await raiseAp().catch((raiseError) => {
          log(`AP setup: failed to re-raise the hotspot: ${String(raiseError)}`)
        })
      }
    } finally {
      connecting = false
    }
  }

  const effectiveThreshold = (): number =>
    hasWifiProfiles === false ? Math.min(2, offlineThreshold) : offlineThreshold

  const tick = async (): Promise<void> => {
    if (stopped || connecting || apActive) return
    lastTickAtMs = Date.now()
    try {
      if (await hasLanConnection()) {
        offlineChecks = 0
        return
      }
      if (hasWifiProfiles === null) {
        const { stdout } = await nmcli(['-t', '-f', 'NAME,TYPE', 'connection', 'show'])
        hasWifiProfiles = stdout.split('\n').some((line) => {
          const [name, type] = parseNmcliTerse(line)
          return Boolean(name) && type === '802-11-wireless' && name !== SETUP_AP_CONNECTION
        })
      }
      offlineChecks += 1
      if (offlineChecks >= effectiveThreshold()) {
        await raiseAp()
      }
    } catch (error) {
      // nmcli missing or NM down — log once per process would be nicer, but this only runs
      // on the appliance where both exist.
      log(`AP setup: connectivity check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const forgetWifiConnections = async (): Promise<number> => {
    const { stdout } = await nmcli(['-t', '-f', 'UUID,TYPE', 'connection', 'show'])
    const uuids: string[] = []
    for (const line of stdout.split('\n')) {
      const [uuid, type] = parseNmcliTerse(line)
      if (uuid && type === '802-11-wireless') uuids.push(uuid)
    }
    for (const uuid of uuids) {
      await nmcli(['connection', 'delete', uuid]).catch(() => undefined)
    }
    // Back to the first-boot state: the profile cache re-resolves to "none saved", which puts
    // the connectivity checks on the fast path to raising the setup AP (~30 s).
    hasWifiProfiles = null
    offlineChecks = 0
    log(`AP setup: removed ${uuids.length} saved Wi-Fi profile(s) — setup AP will re-raise.`)
    return uuids.length
  }

  return {
    enabled: true,
    apSsid,
    forgetWifiConnections,
    start: () => {
      if (timer) return
      timer = setInterval(() => void tick(), checkIntervalMs)
      timer.unref?.()
    },
    stop: () => {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      if (apActive) void dropAp()
    },
    getState: () => ({
      apActive,
      connecting,
      lastError,
      // Anchored to the last check so the value decreases smoothly between 15 s ticks — the
      // TV displays it verbatim (a client-side guess bounced between two values).
      apEtaSeconds: !apActive && !connecting && offlineChecks > 0
        ? Math.max(0, Math.round(
          ((effectiveThreshold() - offlineChecks) * checkIntervalMs - (Date.now() - lastTickAtMs)) / 1000
        ))
        : null
    }),
    scanNetworks: async () => {
      if (apActive) return cachedScan
      try {
        cachedScan = await liveScan()
      } catch {
        // stale cache beats an error page
      }
      return cachedScan
    },
    applyCredentials: (ssid: string, password: string) => {
      if (connecting || !ssid) return false
      connecting = true
      lastError = null
      void applyAsync(ssid, password)
      return true
    },
    tick
  }
}
