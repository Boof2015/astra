// Validation for the settings-transfer write channel, kept separate from the IPC wiring in
// main/index.ts so it can be tested directly.
//
// A settings export is the user's own library data going to a location they just picked in a
// native save dialog, so the 10 MB bound on the general-purpose write primitive does not fit
// it — a large listening history legitimately exceeds that. This channel allows far more in
// exchange for a narrower target: only paths the main process itself handed back from a save
// dialog, so a compromised renderer still cannot name an arbitrary destination.

export const SETTINGS_TRANSFER_WRITE_MAX_BYTES = 256 * 1024 * 1024

export type SettingsTransferWriteCheck =
  | { ok: true }
  | { ok: false; error: string }

export interface SettingsTransferWriteRequest {
  filePath: unknown
  content: unknown
  byteLength: number
  isUserChosenPath: (filePath: string) => boolean
  extensionOf: (filePath: string) => string
  maxBytes?: number
}

export function checkSettingsTransferWrite(
  request: SettingsTransferWriteRequest
): SettingsTransferWriteCheck {
  const { filePath, content, byteLength, isUserChosenPath, extensionOf } = request
  const maxBytes = request.maxBytes ?? SETTINGS_TRANSFER_WRITE_MAX_BYTES

  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return { ok: false, error: 'Invalid file path.' }
  }
  if (typeof content !== 'string') {
    return { ok: false, error: 'Invalid content.' }
  }
  if (!isUserChosenPath(filePath)) {
    return { ok: false, error: 'Settings can only be written to a location chosen in the save dialog.' }
  }
  if (extensionOf(filePath).toLowerCase() !== '.json') {
    return { ok: false, error: 'Settings transfer files must be written as .json.' }
  }
  if (!Number.isFinite(byteLength) || byteLength > maxBytes) {
    return { ok: false, error: 'This settings export is too large to write.' }
  }

  return { ok: true }
}
