import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  BUILTIN_SOFA_HRTF_PROFILES,
  HRTF_PROFILE_MAX_BYTES,
  SADIE_II_D1_KU100_HRTF_PROFILE_ID,
  SOUND_SPHERE_2_AKO_HRTF_PROFILE_ID,
} from '../../types/hrtfProfiles'
import { HrtfProfileService } from './hrtfProfiles'

const BUILTIN_PROFILE_DIR = fileURLToPath(new URL('../../../resources/hrtf/', import.meta.url))
const BUILTIN_NAMES = ['MIT KEMAR', 'SADIE II D1 (KU100)', 'Sound Sphere 2 (AKO)']

function createService(root: string, builtinProfileDir = BUILTIN_PROFILE_DIR): HrtfProfileService {
  return new HrtfProfileService(root, builtinProfileDir)
}

async function withLibrary(run: (root: string, service: HrtfProfileService) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'astra-hrtf-library-'))
  try {
    await run(root, createService(root))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const bytesA = new Uint8Array([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const bytesB = new Uint8Array([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6])
const bytesC = new Uint8Array([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9])

test('lists the procedural and bundled profiles first in stable order', async () => {
  await withLibrary(async (_root, service) => {
    const profiles = await service.list()
    assert.deepEqual(profiles.map((profile) => profile.name), BUILTIN_NAMES)
    assert.ok(profiles.every((profile) => profile.builtIn))
    assert.deepEqual(profiles.map((profile) => profile.kind), ['builtin', 'sofa', 'sofa'])
  })
})

test('reads bundled profiles only after size and SHA-256 verification', async () => {
  await withLibrary(async (_root, service) => {
    for (const profile of BUILTIN_SOFA_HRTF_PROFILES) {
      const result = await service.read(profile.id)
      assert.equal(result.ok, true)
      if (!result.ok) continue
      const bytes = new Uint8Array(result.bytes)
      assert.equal(bytes.byteLength, profile.sizeBytes)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), profile.sha256)
    }
  })
})

test('rejects missing and corrupted bundled profile resources', async () => {
  await withLibrary(async (root, _service) => {
    const missing = await createService(root, join(root, 'missing-bundle')).read(SADIE_II_D1_KU100_HRTF_PROFILE_ID)
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.equal(missing.error.code, 'storage-error')

    const corruptDir = join(root, 'corrupt-bundle')
    await mkdir(corruptDir)
    const profile = BUILTIN_SOFA_HRTF_PROFILES.find((candidate) => candidate.id === SOUND_SPHERE_2_AKO_HRTF_PROFILE_ID)
    assert.ok(profile)
    const corruptBytes = await readFile(join(BUILTIN_PROFILE_DIR, profile.assetFileName))
    corruptBytes[corruptBytes.byteLength - 1] ^= 0xff
    await writeFile(join(corruptDir, profile.assetFileName), corruptBytes)
    const corrupted = await createService(root, corruptDir).read(profile.id)
    assert.equal(corrupted.ok, false)
    if (!corrupted.ok) {
      assert.equal(corrupted.error.code, 'storage-error')
      assert.match(corrupted.error.message, /integrity/i)
    }
  })
})

test('deduplicates bundled SOFA imports without creating a managed copy', async () => {
  await withLibrary(async (root, service) => {
    for (const profile of BUILTIN_SOFA_HRTF_PROFILES) {
      const bytes = await readFile(join(BUILTIN_PROFILE_DIR, profile.assetFileName))
      const result = await service.commit(profile.assetFileName, bytes)
      assert.equal(result.ok, true)
      if (!result.ok) continue
      assert.equal(result.duplicate, true)
      assert.equal(result.profile.id, profile.id)
      assert.equal(result.profile.builtIn, true)
    }
    await assert.rejects(readFile(join(root, 'hrtf-profiles', 'profiles.json')), /ENOENT/)
  })
})

test('refuses removal of every built-in profile without invoking Trash', async () => {
  await withLibrary(async (_root, service) => {
    let trashCalls = 0
    for (const profile of await service.list()) {
      const result = await service.remove(profile.id, async () => { trashCalls += 1 })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.error.message, /built-in/i)
    }
    assert.equal(trashCalls, 0)
  })
})

test('imports, deduplicates, persists, and reads content-addressed profiles', async () => {
  await withLibrary(async (root, service) => {
    const imported = await service.commit('My Ears.sofa', bytesA)
    assert.equal(imported.ok, true)
    if (!imported.ok) return
    assert.equal(imported.duplicate, false)
    assert.equal(imported.profile.name, 'My Ears')
    assert.equal(imported.profile.id, `sofa:${createHash('sha256').update(bytesA).digest('hex')}`)

    const duplicate = await service.commit('A Different Name.sofa', bytesA)
    assert.equal(duplicate.ok, true)
    if (!duplicate.ok) return
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.profile.id, imported.profile.id)

    const afterRestart = createService(root)
    const profiles = await afterRestart.list()
    assert.deepEqual(profiles.map((profile) => profile.name), [...BUILTIN_NAMES, 'My Ears'])
    assert.equal(profiles.at(-1)?.builtIn, false)
    const stored = await afterRestart.read(imported.profile.id)
    assert.equal(stored.ok, true)
    if (stored.ok) assert.deepEqual(new Uint8Array(stored.bytes), bytesA)
  })
})

test('normalizes schema-v1 manifest entries that predate the builtIn field', async () => {
  await withLibrary(async (root, service) => {
    const imported = await service.commit('Legacy.sofa', bytesA)
    assert.equal(imported.ok, true)

    const manifestPath = join(root, 'hrtf-profiles', 'profiles.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      schemaVersion: number
      profiles: Array<Record<string, unknown>>
    }
    delete manifest.profiles[0].builtIn
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const profiles = await createService(root).list()
    assert.equal(profiles.at(-1)?.name, 'Legacy')
    assert.equal(profiles.at(-1)?.builtIn, false)
  })
})

test('gives colliding display names stable numeric suffixes', async () => {
  await withLibrary(async (_root, service) => {
    const first = await service.commit('Studio.sofa', bytesA)
    const second = await service.commit('Studio.sofa', bytesB)
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    if (first.ok && second.ok) {
      assert.equal(first.profile.name, 'Studio')
      assert.equal(second.profile.name, 'Studio (2)')
    }
  })
})

test('serializes concurrent imports into one complete manifest', async () => {
  await withLibrary(async (root, service) => {
    const results = await Promise.all([
      service.commit('Concurrent.sofa', bytesA),
      service.commit('Concurrent.sofa', bytesB),
      service.commit('Concurrent.sofa', bytesC),
    ])
    assert.ok(results.every((result) => result.ok))
    const restarted = await createService(root).list()
    assert.deepEqual(restarted.map((profile) => profile.name), [
      ...BUILTIN_NAMES,
      'Concurrent',
      'Concurrent (2)',
      'Concurrent (3)',
    ])
  })
})

test('rejects invalid extensions, empty files, and candidates larger than 64 MiB', async () => {
  await withLibrary(async (_root, service) => {
    const wrongExtension = await service.commit('profile.bin', bytesA)
    assert.equal(wrongExtension.ok, false)
    if (!wrongExtension.ok) assert.equal(wrongExtension.error.code, 'invalid-extension')

    const empty = await service.commit('empty.sofa', new Uint8Array())
    assert.equal(empty.ok, false)
    if (!empty.ok) assert.equal(empty.error.code, 'file-too-large')

    const oversized = await service.commit('huge.sofa', new Uint8Array(HRTF_PROFILE_MAX_BYTES + 1))
    assert.equal(oversized.ok, false)
    if (!oversized.ok) assert.equal(oversized.error.code, 'file-too-large')
  })
})

test('recovers the last atomic manifest backup and rewrites the primary', async () => {
  await withLibrary(async (root, service) => {
    assert.equal((await service.commit('One.sofa', bytesA)).ok, true)
    assert.equal((await service.commit('Two.sofa', bytesB)).ok, true)
    assert.equal((await service.commit('Three.sofa', bytesC)).ok, true)

    const profileDir = join(root, 'hrtf-profiles')
    const manifestPath = join(profileDir, 'profiles.json')
    await writeFile(manifestPath, '{ interrupted')

    const recovered = await createService(root).list()
    assert.deepEqual(recovered.map((profile) => profile.name), [...BUILTIN_NAMES, 'One', 'Two'])
    const repaired = JSON.parse(await readFile(manifestPath, 'utf8')) as { schemaVersion: number; profiles: unknown[] }
    assert.equal(repaired.schemaVersion, 1)
    assert.equal(repaired.profiles.length, 2)
  })
})

test('drops missing managed files without losing the rest of the library', async () => {
  await withLibrary(async (root, service) => {
    const first = await service.commit('One.sofa', bytesA)
    const second = await service.commit('Two.sofa', bytesB)
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    if (!first.ok) return

    const hash = first.profile.id.slice('sofa:'.length)
    await rm(join(root, 'hrtf-profiles', `${hash}.sofa`))
    const profiles = await createService(root).list()
    assert.deepEqual(profiles.map((profile) => profile.name), [...BUILTIN_NAMES, 'Two'])
  })
})

test('rejects a same-size managed file whose content no longer matches its address', async () => {
  await withLibrary(async (root, service) => {
    const imported = await service.commit('Protected.sofa', bytesA)
    assert.equal(imported.ok, true)
    if (!imported.ok) return
    const hash = imported.profile.id.slice('sofa:'.length)
    await writeFile(join(root, 'hrtf-profiles', `${hash}.sofa`), new Uint8Array(bytesA.byteLength).fill(0x55))
    const result = await service.read(imported.profile.id)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.code, 'storage-error')
      assert.match(result.error.message, /integrity/i)
    }
  })
})

test('moves the managed copy through the supplied Trash operation before removal', async () => {
  await withLibrary(async (root, service) => {
    const imported = await service.commit('Disposable.sofa', bytesA)
    assert.equal(imported.ok, true)
    if (!imported.ok) return

    const trashDir = join(root, 'trash')
    await mkdir(trashDir)
    let trashedPath = ''
    const removed = await service.remove(imported.profile.id, async (filePath) => {
      trashedPath = filePath
      await rename(filePath, join(trashDir, 'Disposable.sofa'))
    })
    assert.equal(removed.ok, true)
    assert.match(trashedPath, /hrtf-profiles[\\/][a-f0-9]{64}\.sofa$/)
    assert.deepEqual((await service.list()).map((profile) => profile.name), BUILTIN_NAMES)
    assert.deepEqual(new Uint8Array(await readFile(join(trashDir, 'Disposable.sofa'))), bytesA)
  })
})
