import type { DynamicPlaylistGroup, DynamicPlaylistNode } from './dynamicPlaylist'

// Editor identities stay out of persisted rules. Carry them across immutable
// edits so removing a sibling cannot move focus or retarget an open sheet.
const identities = new WeakMap<DynamicPlaylistNode, number>()
let nextIdentity = 1
export function dynamicPlaylistNodeId(node: DynamicPlaylistNode): number {
  let id = identities.get(node)
  if (id === undefined) { id = nextIdentity++; identities.set(node, id) }
  return id
}

export function editDynamicPlaylistNode(
  root: DynamicPlaylistGroup,
  targetId: number,
  edit: (node: DynamicPlaylistNode) => DynamicPlaylistNode | null
): DynamicPlaylistGroup {
  const visit = (node: DynamicPlaylistNode): DynamicPlaylistNode | null => {
    const id = dynamicPlaylistNodeId(node)
    if (id === targetId) {
      const replacement = edit(node)
      if (replacement) identities.set(replacement, id)
      return replacement
    }
    if (node.kind !== 'group') return node
    const children = node.children.map(visit).filter((child): child is DynamicPlaylistNode => child !== null)
    if (children.length === node.children.length && children.every((child, index) => child === node.children[index])) return node
    const replacement = { ...node, children }
    identities.set(replacement, id)
    return replacement
  }
  const result = visit(root)
  if (!result || result.kind !== 'group') throw new Error('The root group cannot be removed.')
  return result
}

export function dynamicPlaylistNodeCount(node: DynamicPlaylistNode): number {
  return 1 + (node.kind === 'group' ? node.children.reduce((total, child) => total + dynamicPlaylistNodeCount(child), 0) : 0)
}
