export interface AppBuildInfo {
  version: string
  commitHash: string | null
  shortCommitHash: string | null
  isDirty: boolean
}
