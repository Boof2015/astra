import type { IntegrityDuplicateGroup, IntegrityDuplicateTrashAction } from '../../../types/libraryIntegrity'

export function buildDuplicateTrashActions(
  groups: IntegrityDuplicateGroup[],
  keepByGroup: Readonly<Record<string, string>>
): IntegrityDuplicateTrashAction[] {
  const actions: IntegrityDuplicateTrashAction[] = []

  for (const group of groups) {
    const keepPath = keepByGroup[group.id]
    if (!keepPath || !group.members.some((member) => member.path === keepPath)) continue

    const trashPaths = group.members
      .map((member) => member.path)
      .filter((path) => path !== keepPath)
    if (trashPaths.length === 0) continue

    actions.push({ groupId: group.id, keepPath, trashPaths })
  }

  return actions
}
