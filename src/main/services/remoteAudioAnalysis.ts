import { execFile, spawn } from 'node:child_process'
import { constants, setPriority } from 'node:os'
import { promisify } from 'node:util'
import { parseEbur128Summary, LOUDNESS_FFMPEG_MAX_STDERR_BYTES } from './loudnessAnalysis'
import type { RemoteAudioAnalysis } from '../../types/remoteAudioAnalysis'

const probeFile = promisify(execFile)

/** Scan a completed cache file, never a network stream. PCM is reduced into
 * 512 energy bins as it arrives; a whole decoded track is never retained.
 * EBU analysis runs before waveform resampling, at the source channel layout.
 */
export async function analyzeRemoteAudioFile(file: string, ffmpeg: string, ffprobe: string,
  signal: AbortSignal): Promise<RemoteAudioAnalysis> {
  const { stdout } = await probeFile(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
    { signal, timeout: 20_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
  const probe = JSON.parse(stdout)
  const stream = probe.streams?.find((item: { codec_type?: string }) => item.codec_type === 'audio')
  const channels = Number(stream?.channels)
  const streamDuration = Number(stream?.duration)
  const duration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : Number(probe.format?.duration)
  if (!Number.isInteger(channels) || channels < 1 || channels > 32 || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('Remote analysis requires a complete audio duration and channel layout.')
  }
  return scanRemoteAudio(ffmpeg, ['-i', file], channels, duration, signal)
}

/** Scan only a complete retained Stratum interval set. The producer decodes one
 * cached interval at a time; no second download or whole-track PCM allocation. */
export async function analyzeRemoteAudioPcm(ffmpeg: string,
  source: { sample_rate: number; channels: number; frames: number },
  pcm: AsyncIterable<Buffer>, signal: AbortSignal): Promise<RemoteAudioAnalysis> {
  return scanRemoteAudio(ffmpeg, ['-f', 's32le', '-ar', String(source.sample_rate), '-ac', String(source.channels),
    '-i', 'pipe:0'], source.channels, source.frames / source.sample_rate, signal, pcm, source.frames * source.channels * 4)
}

async function scanRemoteAudio(ffmpeg: string, input: string[], channels: number, duration: number,
  signal: AbortSignal, pcm?: AsyncIterable<Buffer>, expectedBytes?: number): Promise<RemoteAudioAnalysis> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const sums = new Float64Array(512), counts = new Float64Array(512)
    const stride = channels * 4
    let frames = 0, remainder = Buffer.alloc(0), stderr = '', failed = false
    const child = spawn(ffmpeg, ['-hide_banner', '-nostats', '-nostdin', ...input, '-map', '0:a:0', '-vn',
      '-af', 'ebur128=peak=sample:framelog=verbose', '-ar', '8000', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
    { signal, timeout: 180_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.on('error', () => { failed = true })
    const feeding = (async () => {
      let bytes = 0
      if (pcm) for await (const chunk of pcm) {
        signal.throwIfAborted()
        bytes += chunk.length
        if (bytes > expectedBytes!) throw new Error('Unexpected analysis frames.')
        await new Promise<void>((resolve, reject) => {
          let settled = false
          const close = () => done(new Error('Analysis input closed.'))
          const done = (error?: Error | null) => {
            if (settled) return
            settled = true
            child.stdin.removeListener('close', close)
            signal.removeEventListener('abort', close)
            if (error) reject(error); else resolve()
          }
          child.stdin.once('close', close)
          signal.addEventListener('abort', close, { once: true })
          if (child.stdin.destroyed || signal.aborted) close()
          else child.stdin.write(chunk, done)
        })
      }
      if (pcm && bytes !== expectedBytes) throw new Error('Incomplete analysis frames.')
      child.stdin.end()
    })().catch(() => { failed = true; child.kill('SIGKILL') })
    if (child.pid) {
      try { setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL) } catch { /* Best effort. */ }
    }
    child.stdout.on('data', (data: Buffer) => {
      const chunk = remainder.length ? Buffer.concat([remainder, data]) : data
      const end = chunk.length - chunk.length % stride
      for (let offset = 0; offset < end; offset += stride) {
        const bin = Math.min(511, Math.floor(frames++ / (duration * 8000) * 512))
        for (let channel = 0; channel < channels; channel++) {
          const value = chunk.readFloatLE(offset + channel * 4)
          sums[bin] += value * value
          counts[bin]++
        }
      }
      remainder = Buffer.from(chunk.subarray(end))
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (data: string) => { stderr = (stderr + data).slice(-LOUDNESS_FFMPEG_MAX_STDERR_BYTES) })
    // Wait for close even after cancellation so cache shutdown does not remove
    // the scanner's file lease while the child still has the file open.
    child.on('error', () => { failed = true })
    child.on('close', async code => {
      await feeding
      const loudness = parseEbur128Summary(stderr)
      if (failed || signal.aborted || code !== 0 || !frames || remainder.length || !loudness
        || Math.abs(frames / 8000 - duration) > Math.max(0.5, duration * 0.01)) {
        reject(new Error('Remote audio analysis did not finish a complete track.'))
        return
      }
      const peaks = Array.from(sums, (sum, index) => Math.sqrt(sum / Math.max(1, counts[index])))
      const maximum = Math.max(...peaks)
      if (maximum > 0) for (let i = 0; i < peaks.length; i++) peaks[i] /= maximum
      resolve({ version: 1, duration: frames / 8000, peaks, ...loudness })
    })
  })
}
