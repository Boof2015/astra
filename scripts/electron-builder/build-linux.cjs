const { spawnSync } = require('node:child_process')

function linuxBuildArgs(args, hostArch = process.arch) {
  const requested = args.filter(arg => ['--x64', '--arm64', '--ia32', '--armv7l', '--universal'].includes(arg))
  const arch = requested.length ? requested[0].slice(2) : hostArch
  if (requested.length > 1 || !['x64', 'arm64'].includes(arch) || arch !== hostArch) {
    throw new Error('Build one Linux x64 or ARM64 target at a time on its native runner; reinstall dependencies when changing architecture.')
  }
  const suffix = arch === 'x64' ? '' : '-arm64'
  return ['--linux', '--publish', 'never', ...args.filter(arg => !requested.includes(arg)), `--${arch}`,
    `-c.appImage.artifactName=Astra-\${version}-Linux${suffix}.\${ext}`]
}

module.exports = { linuxBuildArgs }
if (require.main === module) {
  if (process.platform !== 'linux') throw new Error('Linux releases must be built on a native Linux runner.')
  const result = spawnSync(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), ...linuxBuildArgs(process.argv.slice(2))], { stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
