const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')

function binaryTarget(header) {
  if (header.length >= 20 && header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const machine = header[5] === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18)
    return { platform: 'linux', arch: ({ 62: 'x64', 183: 'arm64' })[machine] }
  }
  if (header.length >= 8 && header.readUInt32LE(0) === 0xfeedfacf) {
    return { platform: 'darwin', arch: ({ 0x1000007: 'x64', 0x100000c: 'arm64' })[header.readUInt32LE(4)] }
  }
  if (header.length >= 64 && header.toString('ascii', 0, 2) === 'MZ') {
    const offset = header.readUInt32LE(60)
    if (offset + 6 <= header.length && header.readUInt32LE(offset) === 0x4550) {
      return { platform: 'win32', arch: ({ 0x8664: 'x64', 0xaa64: 'arm64' })[header.readUInt16LE(offset + 4)] }
    }
  }
  throw new Error('Unrecognized executable header (expected a native 64-bit binary)')
}

function validateTarget(file, platform, arch) {
  const fd = fs.openSync(file, 'r')
  try {
    const header = Buffer.alloc(64 * 1024)
    const size = fs.readSync(fd, header, 0, header.length, 0)
    assert.deepEqual(binaryTarget(header.subarray(0, size)), { platform, arch }, `Wrong target: ${file}`)
  } finally { fs.closeSync(fd) }
  fs.accessSync(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
}

function assertProbeVersion(version) {
  const match = /^ffprobe version (\d+)\.(\d+)(?:\.|\s|-)/m.exec(version)
  assert.ok(match && (+match[1] > 6 || (+match[1] === 6 && +match[2] >= 1)),
    `ffprobe >=6.1 is required for Atmos detection; received ${version.split('\n')[0]}`)
}

function mediaPaths(resourcesDir, platform) {
  const extension = platform === 'win32' ? '.exe' : ''
  if (!resourcesDir) return { ffmpeg: require('ffmpeg-static'), ffprobe: require('ffmpeg-ffprobe-static').ffprobePath }
  const modules = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules')
  return {
    ffmpeg: path.join(modules, 'ffmpeg-static', `ffmpeg${extension}`),
    ffprobe: path.join(modules, 'ffmpeg-ffprobe-static', `ffprobe${extension}`)
  }
}

function validateMediaBinaries({ resourcesDir, platform = process.platform, arch = process.arch } = {}) {
  assert.ok(['x64', 'arm64'].includes(arch) && (platform !== 'win32' || arch === 'x64'), 'Unsupported release target')
  assert.equal(process.platform, platform, 'Package on a native runner for the target platform')
  assert.equal(process.arch, arch, 'Install dependencies and package on a native runner for the target architecture')
  const paths = mediaPaths(resourcesDir, platform)
  // An empty PATH proves that the shipped tools work without a system FFmpeg installation.
  const options = { env: { ...process.env, PATH: '' }, timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 }
  for (const [name, file] of Object.entries(paths)) {
    assert.ok(file, `${name} did not resolve`)
    validateTarget(file, platform, arch)
    const version = execFileSync(file, ['-version'], { ...options, encoding: 'utf8' })
    if (name === 'ffprobe') assertProbeVersion(version)
    console.log(`[media-binaries] ${platform}/${arch}: ${version.split('\n')[0]}`)
  }
  if (resourcesDir) {
    const packageRoot = path.dirname(paths.ffprobe)
    for (const name of ['ffmpeg', 'ffmpeg.exe']) assert.ok(!fs.existsSync(path.join(packageRoot, name)), `Unused paired ${name} was packaged`)
    const asar = require('@electron/asar')
    const entries = asar.listPackage(path.join(resourcesDir, 'app.asar')).map(entry => entry.replaceAll('\\', '/'))
    assert.ok(!entries.some(entry => /^\/?node_modules\/ffmpeg-ffprobe-static\/ffmpeg(?:\.exe)?$/.test(entry)), 'Unused decoder is inside ASAR')
    for (const name of ['visualizer_dsp.node', 'track_waveform.node', ...(platform === 'darwin' ? ['macos_notch.node'] : [])]) {
      validateTarget(path.join(resourcesDir, 'native', name), platform, arch)
    }
    const sqlite = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
    validateTarget(sqlite, platform, arch)
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-media-smoke-'))
  try {
    const input = path.join(temporary, 'stereo.wav')
    // Decode non-silent AAC: exercise the probe/decoder handoff used by fallback playback.
    execFileSync(paths.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.1', '-ac', '2', input], options)
    const compressed = path.join(temporary, 'stereo.m4a')
    execFileSync(paths.ffmpeg, ['-v', 'error', '-i', input, '-c:a', 'aac', compressed], options)
    const probe = JSON.parse(execFileSync(paths.ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_streams', '-of', 'json', compressed], { ...options, encoding: 'utf8' }))
    assert.equal(probe.streams[0].codec_name, 'aac')
    assert.equal(probe.streams[0].channels, 2)
    assert.equal(probe.streams[0].sample_rate, '48000')
    const pcm = execFileSync(paths.ffmpeg, ['-v', 'error', '-i', compressed, '-map', '0:a:0', '-f', 's16le', '-'], options)
    assert.ok(pcm.length >= 4800 * 2 * 2 && pcm.some(byte => byte !== 0), 'Fallback decoder produced no audio')
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
  console.log('[media-binaries] Probe and playback decode passed with an empty PATH.')
}

module.exports = { binaryTarget, validateTarget, assertProbeVersion, validateMediaBinaries }
if (require.main === module) {
  const resourcesDir = process.argv.find(arg => arg.startsWith('--resources-dir='))?.slice('--resources-dir='.length)
  validateMediaBinaries({ resourcesDir })
}
