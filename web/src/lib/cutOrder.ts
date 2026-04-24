import type { ArtboardState, CanvasNode, GroupNode } from '../types/editor'
import { boundsCentroid, getNodePreviewBounds, type Bounds } from './nodeBounds'

export type CutOrderStrategy = 'auto' | 'manual'

export interface CutOrderLeaf {
  nodeId: string
  /** Blob id this leaf belongs to (auto mode) or a single root id (manual mode).
   *  Leaves sharing a `groupId` cluster into the same job downstream. */
  groupId: string
  /** Display name of the owning blob. */
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
  /** Leaves flagged as "big encompassing" during auto planning. */
  spannerNodeIds: string[]
}

const ROOT_GROUP_ID = '__root__'
const ROOT_GROUP_NAME = 'Root'

// ---------- Tuning constants for the auto planner ----------

/** Bounds area ≥ this fraction of the union-bounds area → leaf is a spanner. */
const SPANNER_AREA_RATIO = 0.35
/** Leaf whose bounds contain this many other leaves' centroids → spanner. */
const SPANNER_CONTAIN_COUNT = 3
/** Extra padding (mm) applied when testing bounds overlap — catches shapes that nearly touch. */
const BLOB_BOUNDS_SLOP_MM = 6
/** Adaptive centroid radius = fraction × geometric mean of the bounds' side lengths. */
const BLOB_RADIUS_FRACTION = 0.6
/** Absolute floor for the adaptive radius (mm). */
const BLOB_MIN_RADIUS_MM = 8
/** A spanner inside an SVG group is only split out when it behaves like the whole-art outline. */
const GLOBAL_SPANNER_AREA_RATIO = 0.65
const GLOBAL_SPANNER_CONTAIN_FRACTION = 0.65

function isGroup(node: CanvasNode | undefined): node is GroupNode {
  return !!node && node.type === 'group'
}

interface LeafInfo {
  nodeId: string
  bounds: Bounds | null
  centroid: { x: number; y: number } | null
  svgIndex: number
  ancestorGroupIds: string[]
}

function collectLeavesInSvgOrder(
  rootIds: string[],
  nodesById: Record<string, CanvasNode>,
): LeafInfo[] {
  const out: LeafInfo[] = []

  function walk(ids: string[], ancestorGroupIds: string[]) {
    for (const id of ids) {
      const node = nodesById[id]
      if (!node || !node.visible) continue
      if (isGroup(node)) {
        walk(node.childIds, [...ancestorGroupIds, id])
      } else {
        out.push({
          nodeId: id,
          bounds: null,
          centroid: null,
          svgIndex: out.length,
          ancestorGroupIds,
        })
      }
    }
  }

  walk(rootIds, [])
  return out
}

function attachGeometry(leaves: LeafInfo[], nodesById: Record<string, CanvasNode>): LeafInfo[] {
  for (const leaf of leaves) {
    const node = nodesById[leaf.nodeId]
    const bounds = node ? getNodePreviewBounds(node, nodesById) : null
    leaf.bounds = bounds
    leaf.centroid = bounds ? boundsCentroid(bounds) : null
  }
  return leaves
}

function boundsArea(b: Bounds): number {
  return Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY)
}

function adaptiveRadius(areaA: number, areaB: number): number {
  const characteristicLength = Math.sqrt(Math.sqrt(Math.max(0, areaA * areaB)))
  return Math.max(BLOB_MIN_RADIUS_MM, BLOB_RADIUS_FRACTION * characteristicLength)
}

function unionAll(bs: Bounds[]): Bounds | null {
  if (bs.length === 0) return null
  let out: Bounds = { ...bs[0]! }
  for (let i = 1; i < bs.length; i += 1) {
    const b = bs[i]!
    out = {
      minX: Math.min(out.minX, b.minX),
      minY: Math.min(out.minY, b.minY),
      maxX: Math.max(out.maxX, b.maxX),
      maxY: Math.max(out.maxY, b.maxY),
    }
  }
  return out
}

function boundsOverlap(a: Bounds, b: Bounds, slop: number): boolean {
  return !(
    a.maxX + slop < b.minX ||
    b.maxX + slop < a.minX ||
    a.maxY + slop < b.minY ||
    b.maxY + slop < a.minY
  )
}

function containsCentroid(b: Bounds, p: { x: number; y: number }): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY
}

class UnionFind {
  private parent: number[]
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
  }
  find(i: number): number {
    let r = i
    while (this.parent[r] !== r) r = this.parent[r]!
    while (this.parent[i] !== r) {
      const n = this.parent[i]!
      this.parent[i] = r
      i = n
    }
    return r
  }
  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent[ra] = rb
  }
}

interface Blob {
  leaves: LeafInfo[]
  bounds: Bounds
  centroid: { x: number; y: number }
  minSvgIndex: number
  isSpanner: boolean
  spannerArea: number
  id: string
  name: string
}

interface Atom {
  leaves: LeafInfo[]
  bounds: Bounds
  centroid: { x: number; y: number }
  minSvgIndex: number
  name: string
  clusterLocked: boolean
  sourceGroupId: string | null
}

interface GroupStats {
  leafCount: number
}

interface GroupStructureStats {
  childGroupCount: number
}

function blobIdFromNodeIds(nodeIds: string[]): string {
  let hash = 2166136261
  for (const nodeId of nodeIds) {
    for (let i = 0; i < nodeId.length; i += 1) {
      hash ^= nodeId.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    hash ^= 0x7c
  }
  return `blob-${(hash >>> 0).toString(36)}`
}

function makeBlob(leaves: LeafInfo[], isSpanner: boolean, fallbackName: string): Blob | null {
  const withBounds = leaves.filter((l) => l.bounds && l.centroid)
  if (withBounds.length === 0) return null
  const bounds = unionAll(withBounds.map((l) => l.bounds!))!
  const centroid = boundsCentroid(bounds)
  const sorted = [...leaves].sort((a, b) => a.svgIndex - b.svgIndex)
  const minSvgIndex = sorted[0]!.svgIndex
  const id = blobIdFromNodeIds(sorted.map((l) => l.nodeId))
  return {
    leaves: sorted,
    bounds,
    centroid,
    minSvgIndex,
    isSpanner,
    spannerArea: isSpanner ? boundsArea(bounds) : 0,
    id,
    name: fallbackName,
  }
}

function makeAtom(leaves: LeafInfo[], fallbackName: string, sourceGroupId: string | null): Atom | null {
  const blob = makeBlob(leaves, false, fallbackName)
  if (!blob) return null
  const boundedLeaves = blob.leaves.filter((leaf) => leaf.bounds)
  const summedArea = boundedLeaves.reduce((sum, leaf) => sum + boundsArea(leaf.bounds!), 0)
  const unionArea = boundsArea(blob.bounds)
  const sparseRepeatedSet =
    boundedLeaves.length >= 3 && unionArea > 0 && summedArea / unionArea < 0.15
  return {
    leaves: blob.leaves,
    bounds: blob.bounds,
    centroid: blob.centroid,
    minSvgIndex: blob.minSvgIndex,
    name: fallbackName,
    clusterLocked: sparseRepeatedSet,
    sourceGroupId,
  }
}

function groupStats(leaves: LeafInfo[]): Map<string, GroupStats> {
  const stats = new Map<string, GroupStats>()
  for (const leaf of leaves) {
    for (const groupId of leaf.ancestorGroupIds) {
      const existing = stats.get(groupId) ?? { leafCount: 0 }
      existing.leafCount += 1
      stats.set(groupId, existing)
    }
  }
  return stats
}

function groupStructureStats(nodesById: Record<string, CanvasNode>): Map<string, GroupStructureStats> {
  const stats = new Map<string, GroupStructureStats>()
  for (const node of Object.values(nodesById)) {
    if (!isGroup(node)) continue
    let childGroupCount = 0
    for (const childId of node.childIds) {
      if (isGroup(nodesById[childId])) childGroupCount += 1
    }
    stats.set(node.id, { childGroupCount })
  }
  return stats
}

function isLeafOnlyGroup(groupId: string | null, structure: Map<string, GroupStructureStats>): boolean {
  return groupId != null && (structure.get(groupId)?.childGroupCount ?? 0) === 0
}

function naturalGroupId(leaf: LeafInfo, stats: Map<string, GroupStats>): string | null {
  for (let i = leaf.ancestorGroupIds.length - 1; i >= 0; i -= 1) {
    const groupId = leaf.ancestorGroupIds[i]!
    if ((stats.get(groupId)?.leafCount ?? 0) >= 2) return groupId
  }
  return null
}

function detectSpanners(leaves: LeafInfo[]): Set<number> {
  const valid = leaves
    .map((l, i) => ({ l, i }))
    .filter((x): x is { l: LeafInfo; i: number } => !!x.l.bounds && !!x.l.centroid)
  if (valid.length === 0) return new Set()

  const unionOfAll = unionAll(valid.map((x) => x.l.bounds!))
  const totalArea = unionOfAll ? boundsArea(unionOfAll) : 0

  const spanners = new Set<number>()
  for (const { l, i } of valid) {
    const area = boundsArea(l.bounds!)
    if (totalArea > 0 && area / totalArea >= SPANNER_AREA_RATIO) {
      spanners.add(i)
      continue
    }
    let containCount = 0
    for (const other of valid) {
      if (other.i === i) continue
      if (containsCentroid(l.bounds!, other.l.centroid!)) {
        containCount += 1
        if (containCount >= SPANNER_CONTAIN_COUNT) break
      }
    }
    if (containCount >= SPANNER_CONTAIN_COUNT) spanners.add(i)
  }
  return spanners
}

function countContainedCentroids(
  leaf: LeafInfo,
  valid: { l: LeafInfo; i: number }[],
  leafIndex: number,
): number {
  if (!leaf.bounds) return 0
  let count = 0
  for (const other of valid) {
    if (other.i === leafIndex) continue
    if (other.l.centroid && containsCentroid(leaf.bounds, other.l.centroid)) count += 1
  }
  return count
}

function shouldIsolateSpanner(
  leaf: LeafInfo,
  leafIndex: number,
  valid: { l: LeafInfo; i: number }[],
  totalArea: number,
  hasNaturalGroup: boolean,
  inLeafOnlyGroup: boolean,
): boolean {
  if (!leaf.bounds) return false
  if (!hasNaturalGroup) return true
  if (inLeafOnlyGroup) return false

  const area = boundsArea(leaf.bounds)
  if (totalArea > 0 && area / totalArea >= GLOBAL_SPANNER_AREA_RATIO) return true

  const contained = countContainedCentroids(leaf, valid, leafIndex)
  const globalContainThreshold = Math.max(
    SPANNER_CONTAIN_COUNT,
    Math.ceil(Math.max(0, valid.length - 1) * GLOBAL_SPANNER_CONTAIN_FRACTION),
  )
  return contained >= globalContainThreshold
}

function clusterByProximity(
  items: {
    leaves?: LeafInfo[]
    bounds: Bounds
    centroid: { x: number; y: number }
    clusterLocked?: boolean
    sourceGroupId?: string | null
  }[],
): number[][] {
  const n = items.length
  const uf = new UnionFind(n)
  for (let i = 0; i < n; i += 1) {
    const a = items[i]!
    const areaA = boundsArea(a.bounds)
    for (let j = i + 1; j < n; j += 1) {
      const b = items[j]!
      if (a.clusterLocked || b.clusterLocked) continue
      if (a.sourceGroupId && b.sourceGroupId && a.sourceGroupId !== b.sourceGroupId) {
        continue
      }
      if (boundsOverlap(a.bounds, b.bounds, BLOB_BOUNDS_SLOP_MM)) {
        uf.union(i, j)
        continue
      }
      const areaB = boundsArea(b.bounds)
      const radius = adaptiveRadius(areaA, areaB)
      const dx = a.centroid.x - b.centroid.x
      const dy = a.centroid.y - b.centroid.y
      if (Math.hypot(dx, dy) <= radius) uf.union(i, j)
    }
  }
  const byRoot = new Map<number, number[]>()
  for (let i = 0; i < n; i += 1) {
    const r = uf.find(i)
    const arr = byRoot.get(r) ?? []
    arr.push(i)
    byRoot.set(r, arr)
  }
  return [...byRoot.values()]
}

function distanceFromBottomLeft(
  p: { x: number; y: number },
  artboard: ArtboardState,
): number {
  // Canvas y grows downward, user-visible bottom-left corner sits at y = artboard.height.
  return Math.hypot(p.x, artboard.height - p.y)
}

function computeAutoBlobs(
  rootIds: string[],
  nodesById: Record<string, CanvasNode>,
  artboard: ArtboardState,
): { blobs: Blob[]; spannerIds: string[] } {
  const leaves = attachGeometry(collectLeavesInSvgOrder(rootIds, nodesById), nodesById)
  if (leaves.length === 0) return { blobs: [], spannerIds: [] }

  const spannerSet = detectSpanners(leaves)
  const valid = leaves
    .map((l, i) => ({ l, i }))
    .filter((x): x is { l: LeafInfo; i: number } => !!x.l.bounds && !!x.l.centroid)
  const unionOfAll = unionAll(valid.map((x) => x.l.bounds!))
  const totalArea = unionOfAll ? boundsArea(unionOfAll) : 0
  const stats = groupStats(leaves)
  const structure = groupStructureStats(nodesById)

  const spannerBlobs: Blob[] = []
  const atomBuckets = new Map<string, { name: string; leaves: LeafInfo[] }>()
  const singletonAtoms: Atom[] = []
  for (let i = 0; i < leaves.length; i += 1) {
    const leaf = leaves[i]!
    const groupId = naturalGroupId(leaf, stats)
    if (
      spannerSet.has(i) &&
      shouldIsolateSpanner(
        leaf,
        i,
        valid,
        totalArea,
        groupId != null,
        isLeafOnlyGroup(groupId, structure),
      )
    ) {
      const node = nodesById[leaf.nodeId]
      const blob = makeBlob([leaf], true, node?.name || leaf.nodeId)
      if (blob) spannerBlobs.push(blob)
    } else if (groupId) {
      const bucket = atomBuckets.get(groupId) ?? {
        name: nodesById[groupId]?.name || 'SVG Group',
        leaves: [],
      }
      bucket.leaves.push(leaf)
      atomBuckets.set(groupId, bucket)
    } else {
      const node = nodesById[leaf.nodeId]
      const atom = makeAtom([leaf], node?.name || leaf.nodeId, null)
      if (atom) singletonAtoms.push(atom)
    }
  }

  const atoms: Atom[] = [...singletonAtoms]
  for (const bucket of atomBuckets.values()) {
    const groupId = naturalGroupId(bucket.leaves[0]!, stats)
    const atom = makeAtom(bucket.leaves, bucket.name, groupId)
    if (atom) atoms.push(atom)
  }
  atoms.sort((a, b) => a.minSvgIndex - b.minSvgIndex)

  const clusters = clusterByProximity(atoms)
  const detailBlobs: Blob[] = []
  for (const indices of clusters) {
    const clusterAtoms = indices.map((i) => atoms[i]!)
    const leavesInCluster = clusterAtoms.flatMap((atom) => atom.leaves)
    const fallbackName = clusterAtoms.length === 1 ? clusterAtoms[0]!.name : 'Cluster'
    const blob = makeBlob(leavesInCluster, false, fallbackName)
    if (blob) detailBlobs.push(blob)
  }

  detailBlobs.sort((a, b) => {
    const da = distanceFromBottomLeft(a.centroid, artboard)
    const db = distanceFromBottomLeft(b.centroid, artboard)
    if (da !== db) return da - db
    return a.minSvgIndex - b.minSvgIndex
  })

  spannerBlobs.sort((a, b) => {
    if (a.spannerArea !== b.spannerArea) return a.spannerArea - b.spannerArea
    return a.minSvgIndex - b.minSvgIndex
  })

  let detailCounter = 0
  for (const blob of detailBlobs) {
    detailCounter += 1
    blob.name = `Cluster ${detailCounter}`
  }

  const blobs = [...detailBlobs, ...spannerBlobs]
  const spannerIds = spannerBlobs.flatMap((b) => b.leaves.map((l) => l.nodeId))
  return { blobs, spannerIds }
}

function computeManualLeafOrder(
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
  manualOrder: string[] | null | undefined,
  artboard: ArtboardState,
): CutOrderResult {
  if (strategy === 'manual' && manualOrder && manualOrder.length > 0) {
    const leaves = computeManualLeafOrder(rootIds, nodesById, manualOrder)
    const sequence: CutOrderLeaf[] = leaves.map((leaf, index) => ({
      nodeId: leaf.nodeId,
      groupId: ROOT_GROUP_ID,
      groupName: ROOT_GROUP_NAME,
      index,
    }))
    return {
      sequence,
      groupOrder: sequence.length > 0 ? [ROOT_GROUP_ID] : [],
      groupNames: sequence.length > 0 ? { [ROOT_GROUP_ID]: ROOT_GROUP_NAME } : {},
      spannerNodeIds: [],
    }
  }

  const { blobs, spannerIds } = computeAutoBlobs(rootIds, nodesById, artboard)
  const sequence: CutOrderLeaf[] = []
  const groupOrder: string[] = []
  const groupNames: Record<string, string> = {}
  for (const blob of blobs) {
    groupOrder.push(blob.id)
    groupNames[blob.id] = blob.name
    for (const leaf of blob.leaves) {
      sequence.push({
        nodeId: leaf.nodeId,
        groupId: blob.id,
        groupName: blob.name,
        index: sequence.length,
      })
    }
  }

  return { sequence, groupOrder, groupNames, spannerNodeIds: spannerIds }
}

export { ROOT_GROUP_ID, ROOT_GROUP_NAME }
