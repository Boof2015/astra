import { execFile } from 'child_process'
import { existsSync } from 'fs'

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
  devicePath?: string
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
  const devicePath = options.devicePath ?? '/dev/cec0'

  if (!options.enabled) {
    return { enabled: false, notifyPlayback: () => undefined, stop: () => undefined }
  }
  if (!existsSync(devicePath)) {
    log(`CEC control enabled but ${devicePath} does not exist — TV control disabled.`)
    return { enabled: false, notifyPlayback: () => undefined, stop: () => undefined }
  }

  const exec = options.exec ?? defaultExec
  const standbyMs = Math.max(1, options.standbyMinutes) * 60_000

  let playing = false
  let tvAwake = false
  let initialized = false
  let physicalAddress: string | null = null
  let standbyTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const warned = new Set<string>()

  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return
    warned.add(key)
    log(message)
  }

  const run = async (label: string, args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await exec('cec-ctl', args)
      return stdout
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      warnOnce(label, `cec-ctl ${label} failed (${detail}) — TV may not respond to CEC.`)
      return null
    }
  }

  // Register as a CEC playback device once; the reply carries our physical address
  // ("Physical Address : 1.0.0.0"), needed to claim the active source.
  const ensureInitialized = async (): Promise<void> => {
    if (initialized) return
    initialized = true
    const stdout = await run('setup', ['--playback', '--osd-name', 'Parallax'])
    const match = stdout?.match(/Physical Address\s*:\s*([0-9a-f]\.[0-9a-f]\.[0-9a-f]\.[0-9a-f])/i)
    physicalAddress = match ? match[1] : null
    if (!physicalAddress) {
      warnOnce('phys-addr', 'Could not determine the CEC physical address — waking the TV will work, switching input may not.')
    }
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
        if (!tvAwake) void wake()
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
