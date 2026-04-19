import type { CanvasNode, GroupNode } from '../types/editor'
import { boundsCentroid, getNodePreviewBounds } from './nodeBounds'

export type CutOrderStrategy = 'svg' | 'ltr' | 'btt' | 'manual'

export interface CutOrderLeaf {
  nodeId: string
  /** The nearest ancestor group id that actually owns this leaf for cut-batching.
   *  If the leaf sits directly under the root tree, the group id is `__root__`. */
  groupId: string
  /** Display name of the owning group (or the leaf's own name for root-level leaves). */
  groupName: string
  /** 0-based global order across all leaves. */
  index: number
}

export interface CutOrderResult {
  sequence: CutOrderLeaf[]
  /** Ordered list of distinct groupIds in the order they first appear in `sequence`. */
  groupOrder: string[]
  /** Map from groupId → human-readable group name. */
  groupNames: Record<string, string>
}

const ROOT_GROUP_ID = '__root__'
const ROOT_GROUP_NAME = 'Root'

function isGroup(node: CanvasNode | undefined): node is GroupNode {
  return !!node && node.type === 'group'
}

function hasChildGroups(group: GroupNode, nodesById: Record<string, CanvasNode>): boolean {
  return group.childIds.some((cid) => isGroup(nodesById[cid]))
}

interface LeafInfo {
  nodeId: string
  groupId: string
  groupName: string
  centroid: { x: number; y: number } | null
}

/** Walk the tree and yield every visible leaf, preserving SVG document order. */
function collectLeavesInSvgOrder(
  rootIds: string[],
  nodesById: Record<string, CanvasNode>,
): LeafInfo[] {
  const out: LeafInfo[] = []

  function walk(ids: string[], inheritedGroupId: string, inheritedGroupName: string) {
    for (const id of ids) {
      const node = nodesById[id]
      if (!node || !node.visible) continue
      if (isGroup(node)) {
        const name = node.name || id
        if (hasChildGroups(node, nodesById)) {
          walk(node.childIds, inheritedGroupId, inheritedGroupName)
        } else {
          for (const childId of node.childIds) {
            const child = nodesById[childId]
            if (!child || !child.visible) continue
            if (isGroup(child)) {
              walk([childId], id, name)
            } else {
              out.push({ nodeId: childId, groupId: id, groupName: name, centroid: null })
            }
          }
        }
      } else {
        out.push({ nodeId: id, groupId: inheritedGroupId, groupName: inheritedGroupName, centroid: null })
      }
    }
  }

  walk(rootIds, ROOT_GROUP_ID, ROOT_GROUP_NAME)
  return out
}

function attachCentroids(leaves: LeafInfo[], nodesById: Record<string, CanvasNode>): LeafInfo[] {
  for (const leaf of leaves) {
    const node = nodesById[leaf.nodeId]
    const bounds = node ? getNodePreviewBounds(node, nodesById) : null
    leaf.centroid = bounds ? boundsCentroid(bounds) : null
  }
  return leaves
}

/** SVG-order planner: preserve document order, cluster siblings under their parent group. */
function computeSvgOrder(rootIds: string[], nodesById: Record<string, CanvasNode>): LeafInfo[] {
  return collectLeavesInSvgOrder(rootIds, nodesById)
}

/** Spatial planner: flatten every leaf and sort by centroid. Ignores SVG group hierarchy. */
function computeSpatialOrder(
  rootIds: string[],
  nodesById: Record<string, CanvasNode>,
  strategy: 'ltr' | 'btt',
): LeafInfo[] {
  const leaves = attachCentroids(collectLeavesInSvgOrder(rootIds, nodesById), nodesById)
  leaves.sort((a, b) => {
    if (!a.centroid && !b.centroid) return 0
    if (!a.centroid) return 1
    if (!b.centroid) return -1
    if (strategy === 'ltr') {
      if (a.centroid.x !== b.centroid.x) return a.centroid.x - b.centroid.x
      return a.centroid.y - b.centroid.y
    }
    // Canvas y grows downward, so larger y = lower on screen.
    if (a.centroid.y !== b.centroid.y) return b.centroid.y - a.centroid.y
    return a.centroid.x - b.centroid.x
  })
  return leaves
}

/** Manual planner: honor explicit override order; append unseen leaves in SVG order. */
function computeManualOrder(
  rootIds: string[],
  nodesById: Record<string, CanvasNode>,
  manualOrder: string[],
): LeafInfo[] {
  const svgLeaves = collectLeavesInSvgOrder(rootIds, nodesById)
  const byId = new Map(svgLeaves.map((l) => [l.nodeId, l]))
  const used = new Set<string>()
  const out: LeafInfo[] = []
  for (const nodeId of manualOrder) {
    const leaf = byId.get(nodeId)
    if (leaf && !used.has(nodeId)) {
      out.push(leaf)
      used.add(nodeId)
    }
  }
  for (const leaf of svgLeaves) {
    if (!used.has(leaf.nodeId)) out.push(leaf)
  }
  return out
}

export function computeCutOrder(
  rootIds: string[],
  nodesById: Record<string, CanvasNode>,
  strategy: CutOrderStrategy,
  manualOrder?: string[] | null,
): CutOrderResult {
  let leaves: LeafInfo[]
  if (strategy === 'manual' && manualOrder && manualOrder.length > 0) {
    leaves = computeManualOrder(rootIds, nodesById, manualOrder)
  } else if (strategy === 'ltr' || strategy === 'btt') {
    leaves = computeSpatialOrder(rootIds, nodesById, strategy)
  } else {
    leaves = computeSvgOrder(rootIds, nodesById)
  }

  const sequence: CutOrderLeaf[] = []
  const groupOrder: string[] = []
  const groupNames: Record<string, string> = {}
  const seenGroups = new Set<string>()
  for (const leaf of leaves) {
    if (!seenGroups.has(leaf.groupId)) {
      seenGroups.add(leaf.groupId)
      groupOrder.push(leaf.groupId)
      groupNames[leaf.groupId] = leaf.groupName
    }
    sequence.push({
      nodeId: leaf.nodeId,
      groupId: leaf.groupId,
      groupName: leaf.groupName,
      index: sequence.length,
    })
  }

  return { sequence, groupOrder, groupNames }
}

export { ROOT_GROUP_ID, ROOT_GROUP_NAME }
