import { execFile } from 'child_process'
import { readdirSync } from 'fs'

// HDMI-CEC TV control for the Parallax OS TV mode: wake the TV (and optionally grab the active
// source) when a stream starts playing or the host connects, put it on standby after an idle
// timeout once playback stops. Uses the kernel CEC device (vc4 on Pi 4/5) via `cec-ctl` from
// v4l-utils — no libcec. Everything is best-effort: a TV that ignores CEC just keeps working as
// a dumb screen, and every failure is logged once rather than thrown (playback must never
// depend on the TV). All settings apply live via updateSettings — a TV-behavior toggle must
// never cost an audio restart.

export type CecWakeOn = 'play' | 'connect' | 'off'

export interface CecSettings {
  /** Master switch (config cecControl). Everything is inert while false. */
  enabled: boolean
  /** What wakes the TV. 'connect' is a superset of 'play': the TV also comes on when the host
   *  attaches, so it shows the idle/now-playing screen before any music starts. */
  wakeOn: CecWakeOn
  /** Claim the TV's input (active source) when waking; false = power control only. */
  switchInput: boolean
  /** Minutes of not-playing before the TV is sent to standby; 0 = never. */
  standbyMinutes: number
}

export interface CecController {
  /** True when CEC adapters exist to drive (regardless of the master switch) — what decides
   *  whether the settings UI offers TV control at all. */
  readonly available: boolean
  // Call with the current "is playing" / "host connected" state as often as convenient;
  // transitions are debounced internally (wake fires on rising edges, standby after the idle
  // timeout).
  notifyPlayback(playing: boolean): void
  notifyConnection(connected: boolean): void
  updateSettings(settings: CecSettings): void
  stop(): void
}

export interface CecControllerOptions {
  settings: CecSettings
  /** CEC adapters to probe; defaults to every /dev/cec* (a Pi has one per HDMI port). */
  devicePaths?: string[]
  exec?: (command: string, args: string[]) => Promise<{ stdout: string }>
  log?: (message: string) => void
}

function defaultExec(command: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout) => {
      if (error) reject(error)
      else resolve({ stdout })
    })
  })
}

export function createCecController(options: CecControllerOptions): CecController {
  const log = options.log ?? ((message) => console.log(`[astra-receiver] ${message}`))

  // A Pi 4/5 has one CEC adapter PER HDMI PORT (/dev/cec0, /dev/cec1). Probe them all and
  // drive the one that reports a real physical address — i.e. the port with the TV on it.
  const devicePaths = options.devicePaths
    ?? readdirSync('/dev')
      .filter((name) => /^cec\d+$/.test(name))
      .map((name) => `/dev/${name}`)
      .sort()
  const available = devicePaths.length > 0

  const exec = options.exec ?? defaultExec

  let settings: CecSettings = { ...options.settings }
  let playing = false
  let connected = false
  let tvAwake = false
  let initialized = false
  let selectedDevice: string | null = null
  let physicalAddress: string | null = null
  let standbyTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const warned = new Set<string>()

  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return
    warned.add(key)
    log(message)
  }

  if (settings.enabled && !available) {
    warnOnce('no-adapters', 'CEC control enabled but no /dev/cec* device exists — TV control disabled.')
  }

  const active = (): boolean => settings.enabled && available && !stopped

  const run = async (label: string, args: string[], device = selectedDevice): Promise<string | null> => {
    try {
      const { stdout } = await exec('cec-ctl', device ? ['-d', device, ...args] : args)
      return stdout
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      warnOnce(label, `cec-ctl ${label} failed (${detail}) — TV may not respond to CEC.`)
      return null
    }
  }

  const parsePhysAddr = (stdout: string | null): string | null => {
    const match = stdout?.match(/Physical Address\s*:\s*([0-9a-f]\.[0-9a-f]\.[0-9a-f]\.[0-9a-f])/i)
    // f.f.f.f = adapter not connected to anything.
    return match && match[1].toLowerCase() !== 'f.f.f.f' ? match[1] : null
  }

  // Register as a CEC playback device on the adapter whose HDMI port actually has the TV: the
  // registration reply carries our physical address, and f.f.f.f means "nothing connected".
  const ensureInitialized = async (): Promise<void> => {
    if (initialized) return
    initialized = true
    for (const device of devicePaths) {
      const stdout = await run('setup', ['--playback', '--osd-name', 'Parallax'], device)
      const physAddr = parsePhysAddr(stdout)
      if (physAddr) {
        selectedDevice = device
        physicalAddress = physAddr
        log(`CEC: registered as "Parallax" on ${device} (physical address ${physAddr}).`)
        return
      }
    }
    // Nothing conclusive — fall back to the first adapter so wake at least goes somewhere.
    selectedDevice = devicePaths[0]
    warnOnce('phys-addr', `Could not determine the CEC physical address on ${devicePaths.join(', ')} — using ${selectedDevice}; waking may work, input switching may not.`)
  }

  const clearStandbyTimer = (): void => {
    if (standbyTimer) {
      clearTimeout(standbyTimer)
      standbyTimer = null
    }
  }

  const standby = async (): Promise<void> => {
    await run('standby', ['--to', '0', '--standby'])
    tvAwake = false
    log('CEC: idle timeout — sent the TV to standby.')
  }

  const scheduleStandby = (): void => {
    if (standbyTimer || !active() || settings.standbyMinutes <= 0) return
    standbyTimer = setTimeout(() => {
      standbyTimer = null
      void standby()
    }, settings.standbyMinutes * 60_000)
    standbyTimer.unref?.()
  }

  const wake = async (): Promise<void> => {
    await ensureInitialized()
    if (stopped) return
    await run('image-view-on', ['--to', '0', '--image-view-on'])
    if (settings.switchInput) {
      // The physical address can be unknown when the TV was off during registration — re-ask
      // the adapter at wake time so active-source (what actually switches inputs) can fire.
      if (!physicalAddress) {
        physicalAddress = parsePhysAddr(await run('phys-addr-query', []))
      }
      if (physicalAddress) {
        await run('active-source', ['--active-source', `phys-addr=${physicalAddress}`])
      }
    }
    tvAwake = true
    log(settings.switchInput ? 'CEC: woke the TV and claimed the active source.' : 'CEC: woke the TV.')
    // Playback may already have stopped while the wake commands were in flight — a TV we woke
    // must always end up with a pending standby once nothing is playing.
    if (!playing && !stopped) scheduleStandby()
  }

  return {
    available,
    notifyPlayback: (nowPlaying: boolean) => {
      if (stopped) return
      if (nowPlaying === playing) return
      playing = nowPlaying
      if (nowPlaying) {
        clearStandbyTimer()
        // Wake on EVERY play edge, not only when we believe the TV is asleep: the user can
        // turn the TV off themselves and our tvAwake bookkeeping can't see that. A redundant
        // image-view-on to a TV that is already on is harmless.
        if (active() && settings.wakeOn !== 'off') void wake()
      } else if (tvAwake) {
        scheduleStandby()
      }
    },
    notifyConnection: (nowConnected: boolean) => {
      if (stopped) return
      if (nowConnected === connected) return
      connected = nowConnected
      // wake() schedules its own standby when nothing is playing, so a connected-but-idle TV
      // still times out. Disconnect needs nothing: mid-play it arrives with a playback stop
      // (which schedules standby), and while idle a standby is already pending or done.
      if (nowConnected && active() && settings.wakeOn === 'connect') void wake()
    },
    updateSettings: (next: CecSettings) => {
      if (stopped) return
      settings = { ...next }
      if (settings.enabled && !available) {
        warnOnce('no-adapters', 'CEC control enabled but no /dev/cec* device exists — TV control disabled.')
        return
      }
      // Re-evaluate the idle timer under the new rules (full duration from now — close enough
      // for a settings click, and far simpler than pro-rating the elapsed idle time).
      clearStandbyTimer()
      if (!settings.enabled) return
      if (tvAwake && !playing) scheduleStandby()
      // If the new trigger says the TV should be on right now and our bookkeeping says it
      // isn't, wake immediately — enabling CEC mid-song must light the TV up.
      const shouldBeAwake = (settings.wakeOn === 'play' && playing)
        || (settings.wakeOn === 'connect' && (connected || playing))
      if (shouldBeAwake && !tvAwake) void wake()
    },
    stop: () => {
      stopped = true
      clearStandbyTimer()
    }
  }
}
