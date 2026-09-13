/** Read only the envelope: unsupported leaf fields must never be discarded. */
export function dynamicPlaylistNeedsV2(playlist: { kind: string; dynamicRules: string | null }): boolean {
  if (playlist.kind !== 'dynamic' || !playlist.dynamicRules) return false
  try {
    const rules = JSON.parse(playlist.dynamicRules)
    return typeof rules?.version === 'number' && rules.version >= 2
  } catch { return false }
}

export function dynamicPlaylistSyncNeedsUpdate(
  peerVersion: number | undefined,
  playlists: readonly { kind: string; dynamicRules: string | null }[]
): boolean {
  return !(typeof peerVersion === 'number' && peerVersion >= 2) && playlists.some(dynamicPlaylistNeedsV2)
}

/** Native sync-state preparation can resolve pending favorites and assign UIDs.
 * Run compatibility checks using read-only rule reads before allowing it. */
export async function prepareDynamicPlaylistSyncState<T>(
  peerVersion: number | undefined,
  remotePlaylists: readonly { kind: string; dynamicRules: string | null }[],
  readLocalPlaylists: () => Promise<readonly { kind: string; dynamicRules: string | null }[]>,
  prepareState: () => Promise<T>
): Promise<T> {
  if (!(typeof peerVersion === 'number' && peerVersion >= 2)) {
    const localPlaylists = await readLocalPlaylists()
    if (dynamicPlaylistSyncNeedsUpdate(peerVersion, [...localPlaylists, ...remotePlaylists])) {
      throw new Error('Update the desktop app before syncing playlists with AND/OR groups.')
    }
  }
  return prepareState()
}
