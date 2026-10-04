/** Providers connected to the shared retained-original playback route. */
export type RetainedRemoteSourceType = 'subsonic' | 'jellyfin'

export function isRetainedRemoteSource(sourceType: string | null | undefined): sourceType is RetainedRemoteSourceType {
  return sourceType === 'subsonic' || sourceType === 'jellyfin'
}

export function retainedRemoteSourceFromPath(path: string | null | undefined): RetainedRemoteSourceType | null {
  if (path?.startsWith('subsonic://')) return 'subsonic'
  if (path?.startsWith('jellyfin://')) return 'jellyfin'
  return null
}
