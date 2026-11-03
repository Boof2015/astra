const { Arch } = require('builder-util')
const { validateMediaBinaries } = require('./validate-media-binaries.cjs')

exports.default = async function afterPackValidateBinaries(context) {
  validateMediaBinaries({
    resourcesDir: context.packager.getResourcesDir(context.appOutDir),
    platform: context.electronPlatformName,
    arch: typeof context.arch === 'number' ? Arch[context.arch] : context.arch
  })
}
