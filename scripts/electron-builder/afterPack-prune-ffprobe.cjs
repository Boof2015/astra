const fs = require('fs/promises')
const path = require('path')

const ARCH_BY_VALUE = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal'
}

const ARCH_ALIASES = {
  amd64: 'x64',
  x86_64: 'x64',
  x86: 'ia32',
  i386: 'ia32',
  i686: 'ia32',
  aarch64: 'arm64',
  arm: 'armv7l'
}

function normalizeArch(rawArch) {
  const archName = typeof rawArch === 'number' ? ARCH_BY_VALUE[rawArch] : String(rawArch)
  if (!archName) return null
  return ARCH_ALIASES[archName] ?? archName
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

exports.default = async function afterPackPruneFfprobe(context) {
  const platform = context.electronPlatformName
  const targetArch = normalizeArch(context.arch)

  if (!platform || !targetArch) {
    console.warn('[afterPack:ffprobe-prune] Missing platform/arch in context. Skipping prune.')
    return
  }

  const binRoot = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'ffprobe-static',
    'bin'
  )

  if (!(await pathExists(binRoot))) {
    console.warn(`[afterPack:ffprobe-prune] ffprobe bin directory not found at ${binRoot}. Skipping prune.`)
    return
  }

  const platformDir = path.join(binRoot, platform)
  if (!(await pathExists(platformDir))) {
    console.warn(
      `[afterPack:ffprobe-prune] Target platform directory "${platform}" is missing at ${platformDir}. Skipping prune.`
    )
    return
  }

  const allPlatformEntries = await fs.readdir(binRoot, { withFileTypes: true })
  for (const entry of allPlatformEntries) {
    if (!entry.isDirectory() || entry.name === platform) continue
    await fs.rm(path.join(binRoot, entry.name), { recursive: true, force: true })
  }

  const archEntries = await fs.readdir(platformDir, { withFileTypes: true })
  const archDirs = archEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  const keepCandidates = new Set([targetArch])
  if (targetArch === 'armv7l') keepCandidates.add('arm')
  if (targetArch === 'arm') keepCandidates.add('armv7l')
  const keepArch = archDirs.find((name) => keepCandidates.has(name)) ?? null

  if (!keepArch) {
    console.warn(
      `[afterPack:ffprobe-prune] No matching arch folder for "${targetArch}" inside ${platformDir}. Kept platform directory as-is.`
    )
    return
  }

  for (const archDir of archDirs) {
    if (archDir === keepArch) continue
    await fs.rm(path.join(platformDir, archDir), { recursive: true, force: true })
  }

  console.log(
    `[afterPack:ffprobe-prune] Kept ffprobe-static bin/${platform}/${keepArch}; removed other platform/arch directories.`
  )
}
