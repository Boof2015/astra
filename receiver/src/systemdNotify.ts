import { loadAlsaAddon, type AlsaAddon } from './output/alsaAddon'

// systemd Type=notify integration: READY=1 once the daemon is serving, WATCHDOG=1 keepalives at
// half the WatchdogSec interval, STOPPING=1 on shutdown. The datagram itself is sent by the
// native addon's sdNotify (NOTIFY_SOCKET is AF_UNIX; Node's dgram is UDP-only). When
// NOTIFY_SOCKET is unset — manual installs, `receiver:dev` on a mac — every call is a no-op.

export interface SystemdNotifier {
  readonly enabled: boolean
  ready(): void
  stopping(): void
  startWatchdog(): void
  stopWatchdog(): void
}

export interface SystemdNotifierOptions {
  env?: Record<string, string | undefined>
  send?: (state: string) => boolean
  log?: (message: string) => void
  loadAddon?: () => AlsaAddon
}

const MIN_WATCHDOG_PING_MS = 1_000

export function createSystemdNotifier(options: SystemdNotifierOptions = {}): SystemdNotifier {
  const env = options.env ?? process.env
  const log = options.log ?? ((message) => console.error(`[astra-receiver] ${message}`))
  const notifySocket = env.NOTIFY_SOCKET?.trim()

  if (!notifySocket) {
    return {
      enabled: false,
      ready: () => undefined,
      stopping: () => undefined,
      startWatchdog: () => undefined,
      stopWatchdog: () => undefined
    }
  }

  let send = options.send
  let warned = false
  const doSend = (state: string): void => {
    if (!send) {
      // Lazy so the addon only loads when systemd is actually supervising. A unit that never
      // receives READY=1 restart-loops, so a missing/old addon must be unmistakable in the journal.
      try {
        const addon = (options.loadAddon ?? loadAlsaAddon)()
        if (typeof addon.sdNotify !== 'function') {
          throw new Error('addon has no sdNotify (built before receiver v0.2.0)')
        }
        send = addon.sdNotify.bind(addon)
      } catch (error) {
        if (!warned) {
          warned = true
          const detail = error instanceof Error ? error.message : String(error)
          log(`NOTIFY_SOCKET is set but sd_notify is unavailable (${detail}) — `
            + 'systemd will not receive READY/WATCHDOG and a Type=notify unit will restart-loop. '
            + 'Update the receiver tarball so the bundle and addon match.')
        }
        return
      }
    }
    send(state)
  }

  let watchdogTimer: ReturnType<typeof setInterval> | null = null

  return {
    enabled: true,
    ready: () => doSend('READY=1'),
    stopping: () => doSend('STOPPING=1'),
    startWatchdog: () => {
      if (watchdogTimer) return
      const usec = Number(env.WATCHDOG_USEC)
      if (!Number.isFinite(usec) || usec <= 0) return
      const intervalMs = Math.max(MIN_WATCHDOG_PING_MS, Math.floor(usec / 1000 / 2))
      watchdogTimer = setInterval(() => doSend('WATCHDOG=1'), intervalMs)
      watchdogTimer.unref?.()
    },
    stopWatchdog: () => {
      if (!watchdogTimer) return
      clearInterval(watchdogTimer)
      watchdogTimer = null
    }
  }
}
