import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
const require = createRequire(import.meta.url)
const { binaryTarget, assertProbeVersion } = require('./validate-media-binaries.cjs')
const { linuxBuildArgs } = require('./build-linux.cjs')
const { expectedArtifactNames } = require('../release/verify-release-artifacts.cjs')

test('reject old ffprobe versions despite misleading package release labels', () => {
  for (const version of ['4.4-tessus', '6.0', 'n6.0.1-9-g123456', 'N-unknown']) assert.throws(() => assertProbeVersion(`ffprobe version ${version} Copyright`))
  for (const version of ['6.1.1', '6.1.1-tessus', 'n6.1.2-9-g4571c80b40-20241023', '7.0.2', 'n7.0.2']) assert.doesNotThrow(() => assertProbeVersion(`ffprobe version ${version} Copyright`))
})

test('recognize native headers across the five desktop targets', () => {
  for (const [arch, machine] of [['x64', 62], ['arm64', 183]] as const) {
    const elf = Buffer.alloc(64)
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); elf.writeUInt16LE(machine, 18)
    assert.deepEqual(binaryTarget(elf), { platform: 'linux', arch })
    const macho = Buffer.alloc(32)
    macho.writeUInt32LE(0xfeedfacf); macho.writeUInt32LE(arch === 'x64' ? 0x1000007 : 0x100000c, 4)
    assert.deepEqual(binaryTarget(macho), { platform: 'darwin', arch })
  }
  const pe = Buffer.alloc(128)
  pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x8664, 68)
  assert.deepEqual(binaryTarget(pe), { platform: 'win32', arch: 'x64' })
  assert.throws(() => binaryTarget(Buffer.from('not an executable')))
})

test('Linux ARM64 filenames are distinct and x64 package-manager URLs remain compatible', () => {
  const x64 = expectedArtifactNames({ platform: 'linux', arch: 'x64', version: 'test' })
  const arm64 = expectedArtifactNames({ platform: 'linux', arch: 'arm64', version: 'test' })
  assert.deepEqual(x64, ['Astra-test-Linux.AppImage', 'Astra-test-Linux-amd64.deb', 'Astra-test-Linux-x86_64.rpm', 'Astra-test-Linux-x64.tar.gz'])
  assert.deepEqual(arm64, ['Astra-test-Linux-arm64.AppImage', 'Astra-test-Linux-arm64.deb', 'Astra-test-Linux-aarch64.rpm', 'Astra-test-Linux-arm64.tar.gz'])
  assert.ok(linuxBuildArgs([], 'x64').includes('-c.appImage.artifactName=Astra-${version}-Linux.${ext}'))
  assert.ok(linuxBuildArgs(['--arm64', '--dir'], 'arm64').includes('-c.appImage.artifactName=Astra-${version}-Linux-arm64.${ext}'))
  assert.throws(() => linuxBuildArgs(['--arm64'], 'x64'))
  assert.throws(() => linuxBuildArgs(['--x64', '--arm64'], 'arm64'))
})
