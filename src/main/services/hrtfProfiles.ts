import { createHash } from 'crypto'
import { basename, extname, join } from 'path'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import {
  BUILTIN_HRTF_PROFILE_ID,
  BUILTIN_SOFA_HRTF_PROFILES,
  HRTF_PROFILE_MAX_BYTES,
  builtinHrtfProfiles,
  type BuiltinSofaHrtfProfileDefinition,
  type HrtfProfileCommitResult,
  type HrtfProfileBytesResult,
  type HrtfProfileRemoveResult,
  type HrtfProfileSummary,
} from '../../types/hrtfProfiles'

const MANIFEST_SCHEMA_VERSION = 1
const MANIFEST_FILE_NAME = 'profiles.json'
const MANIFEST_BACKUP_FILE_NAME = 'profiles.json.bak'

interface StoredHrtfProfile extends HrtfProfileSummary {
  kind: 'sofa'
  builtIn: false
  fileName: string
  sha256: string
}

interface HrtfProfileManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION
  profiles: StoredHrtfProfile[]
}

function emptyManifest(): HrtfProfileManifest {
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, profiles: [] }
}

function normalizeDisplayName(fileName: string): string {
  const base = basename(fileName, extname(fileName)).trim().replace(/[\u0000-\u001f]/g, '')
  return base.slice(0, 120) || 'Imported HRTF'
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function normalizeStoredProfile(value: unknown): StoredHrtfProfile | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<StoredHrtfProfile>
  if (
    candidate.kind !== 'sofa' ||
    !isSha256(candidate.sha256) ||
    candidate.id !== `sofa:${candidate.sha256}` ||
    candidate.fileName !== `${candidate.sha256}.sofa` ||
    typeof candidate.name !== 'string' ||
    candidate.name.trim().length === 0 ||
    typeof candidate.importedAt !== 'string' ||
    !Number.isFinite(candidate.sizeBytes) ||
    Number(candidate.sizeBytes) <= 0 ||
    Number(candidate.sizeBytes) > HRTF_PROFILE_MAX_BYTES
  ) {
    return null
  }
  return {
    id: candidate.id,
    name: candidate.name.trim().slice(0, 120),
    kind: 'sofa',
    builtIn: false,
    importedAt: candidate.importedAt,
    sizeBytes: Math.round(Number(candidate.sizeBytes)),
    fileName: candidate.fileName,
    sha256: candidate.sha256,
  }
}

export class HrtfProfileService {
  private readonly profileDir: string
  private readonly builtinProfileDir: string | null
  private readonly manifestPath: string
  private readonly backupPath: string
  private manifest: HrtfProfileManifest | null = null
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(userDataPath: string, builtinProfileDir: string | null = null) {
    this.profileDir = join(userDataPath, 'hrtf-profiles')
    this.builtinProfileDir = builtinProfileDir
    this.manifestPath = join(this.profileDir, MANIFEST_FILE_NAME)
    this.backupPath = join(this.profileDir, MANIFEST_BACKUP_FILE_NAME)
  }

  private async readManifestFile(filePath: string): Promise<HrtfProfileManifest | null> {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<HrtfProfileManifest>
      if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION || !Array.isArray(parsed.profiles)) return null
      const profiles = parsed.profiles.map(normalizeStoredProfile).filter((profile): profile is StoredHrtfProfile => Boolean(profile))
      return { schemaVersion: MANIFEST_SCHEMA_VERSION, profiles }
    } catch {
      return null
    }
  }

  private async ensureLoaded(): Promise<HrtfProfileManifest> {
    if (this.manifest) return this.manifest
    await mkdir(this.profileDir, { recursive: true })
    const primary = await this.readManifestFile(this.manifestPath)
    const backup = primary ? null : await this.readManifestFile(this.backupPath)
    const recoveredFromBackup = !primary && Boolean(backup)
    this.manifest = primary ?? backup ?? emptyManifest()

    const available: StoredHrtfProfile[] = []
    for (const profile of this.manifest.profiles) {
      try {
        const info = await stat(join(this.profileDir, profile.fileName))
        if (info.isFile() && info.size === profile.sizeBytes) available.push(profile)
      } catch {
        // A stale manifest entry should not make the whole profile library unusable.
      }
    }
    if (available.length !== this.manifest.profiles.length || recoveredFromBackup) {
      this.manifest = { ...this.manifest, profiles: available }
      // Do not replace the known-good backup with a corrupt primary while
      // repairing an interrupted manifest write.
      await this.persistManifest(!recoveredFromBackup)
    }
    return this.manifest
  }

  private async persistManifest(backupExisting = true): Promise<void> {
    if (!this.manifest) return
    await mkdir(this.profileDir, { recursive: true })
    const serialized = `${JSON.stringify(this.manifest, null, 2)}\n`
    const temporaryPath = join(this.profileDir, `.profiles-${process.pid}-${Date.now()}.tmp`)
    const backupTemporaryPath = `${temporaryPath}.bak`
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 })
    try {
      if (backupExisting) {
        try {
          await writeFile(backupTemporaryPath, await readFile(this.manifestPath), { mode: 0o600 })
          await rename(backupTemporaryPath, this.backupPath)
        } catch {
          // The first manifest write has nothing to back up.
        }
      }
      await rename(temporaryPath, this.manifestPath)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      await rm(backupTemporaryPath, { force: true }).catch(() => undefined)
    }
  }

  async list(): Promise<HrtfProfileSummary[]> {
    const manifest = await this.ensureLoaded()
    return [
      ...builtinHrtfProfiles(),
      ...manifest.profiles.map(({ fileName: _fileName, sha256: _sha256, ...profile }) => profile),
    ]
  }

  async commit(fileName: string, input: ArrayBuffer | Uint8Array): Promise<HrtfProfileCommitResult> {
    return this.enqueueMutation(() => this.commitInternal(fileName, input))
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private async commitInternal(fileName: string, input: ArrayBuffer | Uint8Array): Promise<HrtfProfileCommitResult> {
    if (extname(fileName).toLowerCase() !== '.sofa') {
      return { ok: false, error: { code: 'invalid-extension', message: 'Choose an AES69 .sofa HRTF profile.' } }
    }
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
    if (bytes.byteLength === 0 || bytes.byteLength > HRTF_PROFILE_MAX_BYTES) {
      return {
        ok: false,
        error: {
          code: 'file-too-large',
          message: `SOFA profiles must be between 1 byte and ${HRTF_PROFILE_MAX_BYTES / (1024 * 1024)} MiB.`,
        },
      }
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const builtinDuplicate = BUILTIN_SOFA_HRTF_PROFILES.find((profile) => profile.sha256 === sha256)
    if (builtinDuplicate) {
      return { ok: true, profile: toBuiltinSofaSummary(builtinDuplicate), duplicate: true }
    }

    const manifest = await this.ensureLoaded()
    const id = `sofa:${sha256}`
    const duplicate = manifest.profiles.find((profile) => profile.id === id)
    if (duplicate) {
      const { fileName: _storedFileName, sha256: _storedHash, ...profile } = duplicate
      return { ok: true, profile, duplicate: true }
    }

    const takenNames = new Set(manifest.profiles.map((profile) => profile.name.toLocaleLowerCase()))
    const baseName = normalizeDisplayName(fileName)
    let name = baseName
    for (let suffix = 2; takenNames.has(name.toLocaleLowerCase()); suffix++) name = `${baseName} (${suffix})`

    const storedFileName = `${sha256}.sofa`
    const targetPath = join(this.profileDir, storedFileName)
    const temporaryPath = join(this.profileDir, `.${sha256}-${process.pid}.tmp`)
    const stored: StoredHrtfProfile = {
      id,
      name,
      kind: 'sofa',
      builtIn: false,
      importedAt: new Date().toISOString(),
      sizeBytes: bytes.byteLength,
      fileName: storedFileName,
      sha256,
    }

    try {
      await writeFile(temporaryPath, bytes, { mode: 0o600 })
      await rename(temporaryPath, targetPath)
      manifest.profiles.push(stored)
      await this.persistManifest()
      const { fileName: _storedFileName, sha256: _storedHash, ...profile } = stored
      return { ok: true, profile, duplicate: false }
    } catch (error) {
      manifest.profiles = manifest.profiles.filter((profile) => profile.id !== id)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      await rm(targetPath, { force: true }).catch(() => undefined)
      return {
        ok: false,
        error: { code: 'storage-error', message: error instanceof Error ? error.message : 'Failed to store the SOFA profile.' },
      }
    }
  }

  async read(profileId: string): Promise<HrtfProfileBytesResult> {
    if (profileId === BUILTIN_HRTF_PROFILE_ID) {
      return { ok: false, error: { code: 'not-found', message: 'The built-in HRTF does not have a profile file.' } }
    }
    const builtinProfile = BUILTIN_SOFA_HRTF_PROFILES.find((profile) => profile.id === profileId)
    if (builtinProfile) return this.readBuiltinSofa(builtinProfile)

    const manifest = await this.ensureLoaded()
    const profile = manifest.profiles.find((candidate) => candidate.id === profileId)
    if (!profile) return { ok: false, error: { code: 'not-found', message: 'That HRTF profile is no longer available.' } }
    try {
      const bytes = await readFile(join(this.profileDir, profile.fileName))
      if (bytes.byteLength !== profile.sizeBytes || bytes.byteLength > HRTF_PROFILE_MAX_BYTES) throw new Error('The managed profile file is incomplete.')
      const actualSha256 = createHash('sha256').update(bytes).digest('hex')
      if (actualSha256 !== profile.sha256) throw new Error('The managed profile file failed its integrity check.')
      return { ok: true, bytes: toArrayBuffer(bytes) }
    } catch (error) {
      return {
        ok: false,
        error: { code: 'storage-error', message: error instanceof Error ? error.message : 'Failed to read the SOFA profile.' },
      }
    }
  }

  async remove(profileId: string, trashFile: (filePath: string) => Promise<void>): Promise<HrtfProfileRemoveResult> {
    return this.enqueueMutation(() => this.removeInternal(profileId, trashFile))
  }

  private async removeInternal(
    profileId: string,
    trashFile: (filePath: string) => Promise<void>
  ): Promise<HrtfProfileRemoveResult> {
    if (builtinHrtfProfiles().some((profile) => profile.id === profileId)) {
      return { ok: false, error: { code: 'storage-error', message: 'Built-in HRTF profiles cannot be removed.' } }
    }
    const manifest = await this.ensureLoaded()
    const index = manifest.profiles.findIndex((profile) => profile.id === profileId)
    if (index < 0) return { ok: false, error: { code: 'not-found', message: 'That HRTF profile is no longer available.' } }
    const profile = manifest.profiles[index]
    try {
      await trashFile(join(this.profileDir, profile.fileName))
      manifest.profiles.splice(index, 1)
      await this.persistManifest()
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: { code: 'storage-error', message: error instanceof Error ? error.message : 'Failed to remove the SOFA profile.' },
      }
    }
  }

  private async readBuiltinSofa(profile: BuiltinSofaHrtfProfileDefinition): Promise<HrtfProfileBytesResult> {
    if (!this.builtinProfileDir) {
      return { ok: false, error: { code: 'storage-error', message: 'The bundled HRTF resource directory is unavailable.' } }
    }
    try {
      const bytes = await readFile(join(this.builtinProfileDir, profile.assetFileName))
      if (bytes.byteLength !== profile.sizeBytes || bytes.byteLength > HRTF_PROFILE_MAX_BYTES) {
        throw new Error(`The bundled ${profile.name} profile has an unexpected size.`)
      }
      const actualSha256 = createHash('sha256').update(bytes).digest('hex')
      if (actualSha256 !== profile.sha256) {
        throw new Error(`The bundled ${profile.name} profile failed its integrity check.`)
      }
      return { ok: true, bytes: toArrayBuffer(bytes) }
    } catch (error) {
      return {
        ok: false,
        error: { code: 'storage-error', message: error instanceof Error ? error.message : 'Failed to read the bundled HRTF profile.' },
      }
    }
  }
}

function toBuiltinSofaSummary(profile: BuiltinSofaHrtfProfileDefinition): HrtfProfileSummary {
  const { assetFileName: _assetFileName, sha256: _sha256, ...summary } = profile
  return { ...summary }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
