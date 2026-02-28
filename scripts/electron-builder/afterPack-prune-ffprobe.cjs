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

function getBinRootFromResourcesDir(resourcesDir) {
  return path.join(
    resourcesDir,
    'app.asar.unpacked',
    'node_modules',
    'ffprobe-static',
    'bin'
  )
}

async function collectExistingBinRoots(context) {
  const appOutDir = context.appOutDir
  const candidates = new Set([
    getBinRootFromResourcesDir(path.join(appOutDir, 'resources')),
    getBinRootFromResourcesDir(path.join(appOutDir, 'Resources')),
    getBinRootFromResourcesDir(path.join(appOutDir, 'Contents', 'Resources'))
  ])

  const productFilename = context.packager?.appInfo?.productFilename
  if (typeof productFilename === 'string' && productFilename.length > 0) {
    candidates.add(
      getBinRootFromResourcesDir(path.join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources'))
    )
  }

  try {
    const topLevelEntries = await fs.readdir(appOutDir, { withFileTypes: true })
    for (const entry of topLevelEntries) {
      if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue
      candidates.add(
        getBinRootFromResourcesDir(path.join(appOutDir, entry.name, 'Contents', 'Resources'))
      )
    }
  } catch {
    // Ignore candidate discovery failures and rely on existing static candidates.
  }

  const existingRoots = []
  const seenCanonicalRoots = new Set()
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue
    let canonical = candidate
    try {
      canonical = await fs.realpath(candidate)
    } catch {
      // Fall back to the raw candidate path.
    }
    if (seenCanonicalRoots.has(canonical)) continue
    seenCanonicalRoots.add(canonical)
    existingRoots.push(candidate)
  }

  return {
    existingRoots,
    attemptedRoots: Array.from(candidates)
  }
}

async function pruneSingleBinRoot(binRoot, platform, targetArch) {
  const platformDir = path.join(binRoot, platform)
  if (!(await pathExists(platformDir))) {
    console.warn(
      `[afterPack:ffprobe-prune] Target platform directory "${platform}" is missing at ${platformDir}. Skipping prune for this root.`
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
    `[afterPack:ffprobe-prune] Kept ffprobe-static ${platform}/${keepArch} at ${binRoot}; removed other platform/arch directories.`
  )
}

exports.default = async function afterPackPruneFfprobe(context) {
  const platform = context.electronPlatformName
  const targetArch = normalizeArch(context.arch)

  if (!platform || !targetArch) {
    console.warn('[afterPack:ffprobe-prune] Missing platform/arch in context. Skipping prune.')
    return
  }

  const { existingRoots, attemptedRoots } = await collectExistingBinRoots(context)
  if (existingRoots.length === 0) {
    console.warn(
      `[afterPack:ffprobe-prune] ffprobe bin directory not found under appOutDir=${context.appOutDir}. Attempted: ${attemptedRoots.join(' | ')}`
    )
    return
  }

  for (const binRoot of existingRoots) {
    await pruneSingleBinRoot(binRoot, platform, targetArch)
  }
}
