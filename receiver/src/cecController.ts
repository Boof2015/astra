import { execFile } from 'child_process'
import { readdirSync } from 'fs'

// HDMI-CEC TV control for the Parallax OS TV mode: wake the TV and grab the active source when
// a stream starts playing, put it on standby after an idle timeout once playback stops. Uses
// the kernel CEC device (vc4 on Pi 4/5) via `cec-ctl` from v4l-utils — no libcec. Everything is
// best-effort: a TV that ignores CEC just keeps working as a dumb screen, and every failure is
// logged once rather than thrown (playback must never depend on the TV).

export interface CecController {
  readonly enabled: boolean
  // Call with the current "is playing" state as often as convenient; transitions are debounced
  // internally (wake fires on the not-playing → playing edge, standby after the idle timeout).
  notifyPlayback(playing: boolean): void
  stop(): void
}

export interface CecControllerOptions {
  enabled: boolean
  standbyMinutes: number
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

  if (!options.enabled) {
    return { enabled: false, notifyPlayback: () => undefined, stop: () => undefined }
  }
  // A Pi 4/5 has one CEC adapter PER HDMI PORT (/dev/cec0, /dev/cec1). Probe them all and
  // drive the one that reports a real physical address — i.e. the port with the TV on it.
  const devicePaths = options.devicePaths
    ?? readdirSync('/dev')
      .filter((name) => /^cec\d+$/.test(name))
      .map((name) => `/dev/${name}`)
      .sort()
  if (devicePaths.length === 0) {
    log('CEC control enabled but no /dev/cec* device exists — TV control disabled.')
    return { enabled: false, notifyPlayback: () => undefined, stop: () => undefined }
  }

  const exec = options.exec ?? defaultExec
  const standbyMs = Math.max(1, options.standbyMinutes) * 60_000

  let playing = false
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
    if (standbyTimer) return
    standbyTimer = setTimeout(() => {
      standbyTimer = null
      void standby()
    }, standbyMs)
    standbyTimer.unref?.()
  }

  const wake = async (): Promise<void> => {
    await ensureInitialized()
    if (stopped) return
    // The physical address can be unknown when the TV was off during registration — re-ask
    // the adapter at wake time so active-source (what actually switches inputs) can fire.
    if (!physicalAddress) {
      physicalAddress = parsePhysAddr(await run('phys-addr-query', []))
    }
    await run('image-view-on', ['--to', '0', '--image-view-on'])
    if (physicalAddress) {
      await run('active-source', ['--active-source', `phys-addr=${physicalAddress}`])
    }
    tvAwake = true
    log('CEC: woke the TV and claimed the active source.')
    // Playback may already have stopped while the wake commands were in flight — a TV we woke
    // must always end up with a pending standby once nothing is playing.
    if (!playing && !stopped) scheduleStandby()
  }

  return {
    enabled: true,
    notifyPlayback: (nowPlaying: boolean) => {
      if (stopped) return
      if (nowPlaying === playing) return
      playing = nowPlaying
      if (nowPlaying) {
        clearStandbyTimer()
        // Wake on EVERY play edge, not only when we believe the TV is asleep: the user can
        // turn the TV off themselves and our tvAwake bookkeeping can't see that. A redundant
        // image-view-on to a TV that is already on is harmless.
        void wake()
      } else if (tvAwake) {
        scheduleStandby()
      }
    },
    stop: () => {
      stopped = true
      clearStandbyTimer()
    }
  }
}
