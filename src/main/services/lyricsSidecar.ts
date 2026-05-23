import { access, readdir, readFile } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import { parseLyricsText } from './lyricsParsing'
import type { LyricsFormat, LyricsLookupResult, LyricsPayload, LyricsSource } from '../../types/lyrics'

const LRC_EXTENSION = '.lrc'
const XLRC_EXTENSION = '.xlrc'
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//

type SidecarLrcLookupResult = Extract<LyricsLookupResult, { status: 'hit' }>

function isLocalFilesystemPath(trackPath: string): boolean {
  return !URL_SCHEME_PATTERN.test(trackPath)
}

async function findExtensionCaseFallback(
  candidateDirectory: string,
  audioStem: string,
  extension: string
): Promise<string | null> {
  try {
    const entries = await readdir(candidateDirectory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.startsWith(audioStem)) continue
      const entryExtension = entry.name.slice(audioStem.length)
      if (entryExtension.toLocaleLowerCase() !== extension) continue
      return join(candidateDirectory, entry.name)
    }
  } catch {
    return null
  }

  return null
}

async function resolveSidecarPathByExtension(trackPath: string, extension: string): Promise<string | null> {
  const normalizedTrackPath = trackPath.trim()
  if (!normalizedTrackPath || !isLocalFilesystemPath(normalizedTrackPath)) return null

  const trackExtension = extname(normalizedTrackPath)
  const audioStem = basename(normalizedTrackPath, trackExtension)
  if (!audioStem) return null

  const candidateDirectory = dirname(normalizedTrackPath)
  const exactCandidate = join(candidateDirectory, `${audioStem}${extension}`)
  try {
    await access(exactCandidate)
    return exactCandidate
  } catch {
    return findExtensionCaseFallback(candidateDirectory, audioStem, extension)
  }
}

export async function resolveSidecarLrcPath(trackPath: string): Promise<string | null> {
  return resolveSidecarPathByExtension(trackPath, LRC_EXTENSION)
}

export async function resolveSidecarXlrcPath(trackPath: string): Promise<string | null> {
  return resolveSidecarPathByExtension(trackPath, XLRC_EXTENSION)
}

async function resolveSidecarLyricsByExtension(
  trackPath: string,
  extension: string,
  source: LyricsSource,
  format: LyricsFormat
): Promise<LyricsPayload | null> {
  const sidecarPath = await resolveSidecarPathByExtension(trackPath, extension)
  if (!sidecarPath) return null

  try {
    const content = await readFile(sidecarPath, 'utf-8')
    return parseLyricsText(content, source, format)
  } catch {
    return null
  }
}

export async function resolveSidecarLrcLyrics(trackPath: string): Promise<LyricsPayload | null> {
  return resolveSidecarLyricsByExtension(trackPath, LRC_EXTENSION, 'lrc', 'lrc')
}

export async function resolveSidecarXlrcLyrics(trackPath: string): Promise<LyricsPayload | null> {
  return resolveSidecarLyricsByExtension(trackPath, XLRC_EXTENSION, 'xlrc', 'xlrc')
}

export async function lookupSidecarLrcLyrics(trackPath: string): Promise<SidecarLrcLookupResult | null> {
  const lyrics = await resolveSidecarLrcLyrics(trackPath)
  if (!lyrics) return null

  return {
    status: 'hit',
    lyrics,
    cached: false
  }
}

export async function lookupSidecarXlrcLyrics(trackPath: string): Promise<SidecarLrcLookupResult | null> {
  const lyrics = await resolveSidecarXlrcLyrics(trackPath)
  if (!lyrics) return null

  return {
    status: 'hit',
    lyrics,
    cached: false
  }
}

export async function lookupSidecarLyrics(trackPath: string): Promise<SidecarLrcLookupResult | null> {
  return await lookupSidecarXlrcLyrics(trackPath) ?? await lookupSidecarLrcLyrics(trackPath)
}
