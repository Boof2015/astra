#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '../..')

function parseArgs(argv) {
  const result = {}
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue
    const separatorIndex = arg.indexOf('=')
    if (separatorIndex === -1) {
      result[arg.slice(2)] = 'true'
      continue
    }
    result[arg.slice(2, separatorIndex)] = arg.slice(separatorIndex + 1)
  }
  return result
}

function normalizePlatform(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'linux') return 'linux'
  if (normalized === 'darwin' || normalized === 'mac' || normalized === 'macos') return 'darwin'
  if (normalized === 'win32' || normalized === 'windows' || normalized === 'win') return 'win32'
  return normalized
}

function toDebArch(arch) {
  if (arch === 'x64') return 'amd64'
  if (arch === 'arm64') return 'arm64'
  if (arch === 'ia32') return 'i386'
  if (arch === 'armv7l') return 'armhf'
  return arch
}

function toRpmArch(arch) {
  if (arch === 'x64') return 'x86_64'
  if (arch === 'arm64') return 'aarch64'
  if (arch === 'ia32') return 'i686'
  return arch
}

function expectedArtifactNames({ platform, arch, version }) {
  if (platform === 'linux') {
    return [
      `Astra-${version}-Linux.AppImage`,
      `Astra-${version}-Linux-${toDebArch(arch)}.deb`,
      `Astra-${version}-Linux-${toRpmArch(arch)}.rpm`,
      `Astra-${version}-Linux-${arch}.tar.gz`,
    ]
  }

  if (platform === 'darwin') {
    return [
      `Astra-${version}-Mac-${arch}.dmg`,
      `Astra-${version}-Mac-${arch}.zip`,
    ]
  }

  if (platform === 'win32') {
    return [
      `Astra.Setup.${version}.Windows.exe`,
      `Astra.Portable.${version}.Windows.exe`,
    ]
  }

  throw new Error(`Unsupported release artifact platform: ${platform}`)
}

function listDistFiles(distDir) {
  try {
    return fs.readdirSync(distDir).sort()
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const platform = normalizePlatform(args.platform || process.env.ASTRA_RELEASE_PLATFORM || process.platform)
  const arch = args.arch || process.env.ASTRA_RELEASE_ARCH || process.arch
  const version = args.version || process.env.ASTRA_RELEASE_VERSION || packageJson.version
  const distDir = path.resolve(repoRoot, args['dist-dir'] || process.env.ASTRA_RELEASE_DIST_DIR || 'dist')
  const expectedNames = expectedArtifactNames({ platform, arch, version })
  const missingNames = expectedNames.filter((name) => {
    const filePath = path.join(distDir, name)
    try {
      return !fs.statSync(filePath).isFile()
    } catch (error) {
      if (error && error.code === 'ENOENT') return true
      throw error
    }
  })

  if (missingNames.length > 0) {
    console.error('[verify-release-artifacts] Missing expected release artifact(s):')
    for (const name of missingNames) {
      console.error(`  - ${name}`)
    }

    const actualNames = listDistFiles(distDir)
    console.error(`[verify-release-artifacts] Files currently in ${distDir}:`)
    if (actualNames.length === 0) {
      console.error('  (none)')
    } else {
      for (const name of actualNames) {
        console.error(`  - ${name}`)
      }
    }
    process.exit(1)
  }

  console.log(`[verify-release-artifacts] ${platform}/${arch} release artifacts look valid.`)
  for (const name of expectedNames) {
    console.log(`  - ${name}`)
  }
}

main()
