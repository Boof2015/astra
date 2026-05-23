import type { PlaylistExportResult, PlaylistImportResult } from '../stores/playlistStore'

export type PlaylistImportStatusTone = 'success' | 'warning' | 'error'

export interface PlaylistImportStatus {
  tone: PlaylistImportStatusTone
  message: string
}

export function formatPlaylistImportStatus(result: PlaylistImportResult): PlaylistImportStatus {
  const detailSegments: string[] = []
  if (result.matchedByMetadataCount > 0) {
    detailSegments.push(`${result.matchedByMetadataCount} matched by metadata`)
  }
  if (result.missingEntryCount > 0) {
    detailSegments.push(`${result.missingEntryCount} preserved missing`)
  }
  if (result.ambiguousMetadataCount > 0) {
    detailSegments.push(`${result.ambiguousMetadataCount} ambiguous`)
  }
  if (result.unsupportedEntryCount > 0) {
    detailSegments.push(`${result.unsupportedEntryCount} unsupported`)
  }
  const details = detailSegments.length > 0 ? ` (${detailSegments.join(' \u00b7 ')})` : ''

  const addedEntryCount = result.importedCount + result.missingEntryCount

  if (addedEntryCount <= 0 || result.playlistId === null || !result.playlistName) {
    return {
      tone: 'error',
      message: `No tracks were imported from ${result.entriesTotal} entries.${details}`
    }
  }

  const skippedCount = result.entriesTotal - addedEntryCount
  if (skippedCount > 0) {
    return {
      tone: 'warning',
      message: `Imported ${addedEntryCount}/${result.entriesTotal} entries to "${result.playlistName}".${details}`
    }
  }

  if (result.missingEntryCount <= 0) {
    return {
      tone: 'success',
      message: `Imported ${result.importedCount} tracks to "${result.playlistName}".`
    }
  }

  return {
    tone: 'warning',
    message: `Imported ${addedEntryCount} ${addedEntryCount === 1 ? 'entry' : 'entries'} to "${result.playlistName}".${details}`
  }
}

function getFileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

export function formatPlaylistExportStatus(result: PlaylistExportResult): PlaylistImportStatus {
  const fileName = getFileNameFromPath(result.filePath)
  const entryLabel = result.exportedCount === 1 ? 'entry' : 'entries'
  const warningDetail = result.warnings.length > 0 ? ` ${result.warnings[0]}` : ''

  return {
    tone: result.warnings.length > 0 ? 'warning' : 'success',
    message: `Exported ${result.exportedCount} ${entryLabel} to "${fileName}".${warningDetail}`
  }
}
