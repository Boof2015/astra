import { BUILTIN_HRTF_PROFILE_ID, type HrtfProfileSummary } from '../../types/hrtfProfiles'

export function resolveAvailableHrtfProfileId(
  profiles: readonly HrtfProfileSummary[],
  persistedProfileId: string | null,
  currentProfileId: string
): string {
  const preferred = persistedProfileId || currentProfileId
  return profiles.some((profile) => profile.id === preferred)
    ? preferred
    : BUILTIN_HRTF_PROFILE_ID
}
