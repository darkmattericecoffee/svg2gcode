import type { ArtboardState, CanvasNode, Job, MachiningSettings, PathAnchor } from '../types/editor'
import type { CutOrderResult } from './cutOrder'
import { boundsCentroid, getNodePreviewBounds, type Bounds } from './nodeBounds'

export interface ComputedJob extends Job {
  /** Union bounds of the job's leaves in artboard mm. */
  boundsMm: Bounds
  /** Anchor-resolved reference point in artboard mm. */
  anchorPointMm: { x: number; y: number }
  /** Pencil-cross offset measured from the artboard's bottom-left corner (mm). */
  crossOffsetFromArtboardBL: { x: number; y: number }
  /** Derived via the containment pass (true even when `forceOwnJob` is false). */
  isBigSpanner: boolean
  /** `true` when the partition came from `manualJobs`; `false` when auto-derived. */
  fromManualOverride: boolean
}

const MIN_CLUSTER_RADIUS_MM = 40
const MAX_CLUSTER_RADIUS_MM = 200
const AUTO_CLUSTER_FRACTION = 0.15
const JOB_ID_PREFIX = 'job'

/** Resolve the effective cluster radius in mm. Callers may pass the stored
 *  value; `null` triggers the artboard-scaled default. */
export function resolveJobClusterRadius(
  stored: number | null,
  artboard: ArtboardState,
): number {
  if (stored != null && stored > 0) return stored
  const span = Math.max(artboard.width, artboard.height)
  return clamp(span * AUTO_CLUSTER_FRACTION, MIN_CLUSTER_RADIUS_MM, MAX_CLUSTER_RADIUS_MM)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

function centroidDistance(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function anchorPoint(anchor: PathAnchor, bounds: Bounds): { x: number; y: number } {
  const midX = (bounds.minX + bounds.maxX) / 2
  const midY = (bounds.minY + bounds.maxY) / 2
  const x =
    anchor === 'TopLeft' || anchor === 'MiddleLeft' || anchor === 'BottomLeft'
      ? bounds.minX
      : anchor === 'TopRight' || anchor === 'MiddleRight' || anchor === 'BottomRight'
        ? bounds.maxX
        : midX
  const y =
    anchor === 'TopLeft' || anchor === 'TopCenter' || anchor === 'TopRight'
      ? bounds.minY
      : anchor === 'BottomLeft' || anchor === 'BottomCenter' || anchor === 'BottomRight'
        ? bounds.maxY
        : midY
  return { x, y }
}

function unionBounds(all: (Bounds | null)[]): Bounds | null {
  let out: Bounds | null = null
  for (const b of all) {
    if (!b) continue
    out = out
      ? {
          minX: Math.min(out.minX, b.minX),
          minY: Math.min(out.minY, b.minY),
          maxX: Math.max(out.maxX, b.maxX),
          maxY: Math.max(out.maxY, b.maxY),
        }
      : b
  }
  return out
}

/** Simple union-find over integer indices. */
class UnionFind {
  parent: number[]
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
  }
  find(i: number): number {
    let r = i
    while (this.parent[r] !== r) r = this.parent[r]
    while (this.parent[i] !== r) {
      const n = this.parent[i]
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

function hashString(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function stableJobId(nodeIds: string[], fallbackIndex = 0): string {
  const source = nodeIds.length > 0 ? nodeIds.join('|') : `empty-${fallbackIndex}`
  return `${JOB_ID_PREFIX}-${hashString(source)}`
}

function makeUniqueJobId(nodeIds: string[], usedIds: Set<string>, fallbackIndex = 0): string {
  const base = stableJobId(nodeIds, fallbackIndex)
  if (!usedIds.has(base)) {
    usedIds.add(base)
    return base
  }
  let suffix = 2
  while (usedIds.has(`${base}-${suffix}`)) suffix += 1
  const id = `${base}-${suffix}`
  usedIds.add(id)
  return id
}

function makeManualJob(nodeIds: string[], index: number, usedIds: Set<string>): Job {
  return {
    id: makeUniqueJobId(nodeIds, usedIds, index),
    name: `Job ${index + 1}`,
    nodeIds,
    pathAnchor: 'Center',
    forceOwnJob: false,
  }
}

function orderedLeafIds(cutOrder: CutOrderResult): string[] {
  return cutOrder.sequence.map((leaf) => leaf.nodeId)
}

function cutOrderIndexMap(cutOrder: CutOrderResult): Map<string, number> {
  return new Map(cutOrder.sequence.map((leaf, index) => [leaf.nodeId, index]))
}

function sortNodeIdsByCutOrder(nodeIds: string[], orderIndex: Map<string, number>): string[] {
  return [...nodeIds].sort(
    (a, b) => (orderIndex.get(a) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b) ?? Number.MAX_SAFE_INTEGER),
  )
}

function uniqueJobId(id: string, usedIds: Set<string>, nodeIds: string[], fallbackIndex: number): string {
  const base = id || stableJobId(nodeIds, fallbackIndex)
  if (!usedIds.has(base)) {
    usedIds.add(base)
    return base
  }
  let suffix = 2
  while (usedIds.has(`${base}-${suffix}`)) suffix += 1
  const next = `${base}-${suffix}`
  usedIds.add(next)
  return next
}

function renumberJobNames(jobs: Job[]): Job[] {
  return jobs.map((job, index) => ({
    ...job,
    name: /^Job\s+\d+$/i.test(job.name.trim()) ? `Job ${index + 1}` : job.name,
  }))
}

export function manualJobsFromComputed(jobs: ComputedJob[]): Job[] {
  return jobs.map((job) => ({
    id: job.id,
    name: job.name,
    nodeIds: [...job.nodeIds],
    pathAnchor: job.pathAnchor,
    forceOwnJob: job.forceOwnJob,
  }))
}

export function normalizeManualJobs(cutOrder: CutOrderResult, jobs: Job[] | null): Job[] {
  const leaves = orderedLeafIds(cutOrder)
  if (leaves.length === 0) return []
  if (!jobs || jobs.length === 0) {
    const usedIds = new Set<string>()
    return [makeManualJob(leaves, 0, usedIds)]
  }

  const validLeafIds = new Set(leaves)
  const orderIndex = cutOrderIndexMap(cutOrder)
  const sourceByLeafId = new Map<string, number>()
  for (let jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
    for (const nodeId of jobs[jobIndex]?.nodeIds ?? []) {
      if (validLeafIds.has(nodeId) && !sourceByLeafId.has(nodeId)) {
        sourceByLeafId.set(nodeId, jobIndex)
      }
    }
  }

  const buckets = jobs.map(() => [] as string[])
  let currentJobIndex = jobs.findIndex((job) => job.nodeIds.some((nodeId) => validLeafIds.has(nodeId)))
  if (currentJobIndex < 0) currentJobIndex = 0

  for (const nodeId of leaves) {
    const explicitJobIndex = sourceByLeafId.get(nodeId)
    if (explicitJobIndex != null) currentJobIndex = explicitJobIndex
    buckets[currentJobIndex]?.push(nodeId)
  }

  const usedIds = new Set<string>()
  const normalized: Job[] = []
  for (let index = 0; index < jobs.length; index += 1) {
    const nodeIds = sortNodeIdsByCutOrder([...new Set(buckets[index] ?? [])], orderIndex)
    if (nodeIds.length === 0) continue
    const source = jobs[index]!
    normalized.push({
      id: uniqueJobId(source.id, usedIds, nodeIds, index),
      name: source.name || `Job ${normalized.length + 1}`,
      nodeIds,
      pathAnchor: source.pathAnchor,
      forceOwnJob: source.forceOwnJob,
    })
  }

  if (normalized.length === 0) {
    normalized.push(makeManualJob(leaves, 0, usedIds))
  }

  return renumberJobNames(normalized)
}

export function splitManualJobsAtCutIndex(
  cutOrder: CutOrderResult,
  jobs: Job[] | null,
  cutIndex: number,
): Job[] {
  const leaves = orderedLeafIds(cutOrder)
  if (cutIndex <= 0 || cutIndex >= leaves.length) {
    return normalizeManualJobs(cutOrder, jobs)
  }

  const normalized = normalizeManualJobs(cutOrder, jobs)
  const targetNodeId = leaves[cutIndex]
  if (!targetNodeId) return normalized

  const jobIndex = normalized.findIndex((job) => job.nodeIds.includes(targetNodeId))
  if (jobIndex < 0) return normalized
  const job = normalized[jobIndex]!
  const splitIndex = job.nodeIds.indexOf(targetNodeId)
  if (splitIndex <= 0) return normalized

  const beforeIds = job.nodeIds.slice(0, splitIndex)
  const afterIds = job.nodeIds.slice(splitIndex)
  const usedIds = new Set(normalized.map((entry, index) => (index === jobIndex ? '' : entry.id)).filter(Boolean))
  const newJob: Job = {
    id: makeUniqueJobId(afterIds, usedIds, normalized.length),
    name: `Job ${jobIndex + 2}`,
    nodeIds: afterIds,
    pathAnchor: job.pathAnchor,
    forceOwnJob: false,
  }

  return renumberJobNames([
    ...normalized.slice(0, jobIndex),
    { ...job, nodeIds: beforeIds },
    newJob,
    ...normalized.slice(jobIndex + 1),
  ])
}

export function assignLeafIdsToJob(
  cutOrder: CutOrderResult,
  jobs: Job[] | null,
  leafIds: string[],
  targetJobId: string | 'new',
): Job[] {
  const validLeaves = new Set(orderedLeafIds(cutOrder))
  const selected = [...new Set(leafIds)].filter((id) => validLeaves.has(id))
  if (selected.length === 0) return normalizeManualJobs(cutOrder, jobs)

  const orderIndex = cutOrderIndexMap(cutOrder)
  const sortedSelected = sortNodeIdsByCutOrder(selected, orderIndex)
  const selectedSet = new Set(sortedSelected)
  const stripped = normalizeManualJobs(cutOrder, jobs)
    .map((job) => ({
      ...job,
      nodeIds: job.nodeIds.filter((nodeId) => !selectedSet.has(nodeId)),
    }))
    .filter((job) => job.nodeIds.length > 0)

  if (targetJobId !== 'new') {
    const target = stripped.find((job) => job.id === targetJobId)
    if (target) {
      target.nodeIds = sortNodeIdsByCutOrder([...target.nodeIds, ...sortedSelected], orderIndex)
    } else {
      const original = normalizeManualJobs(cutOrder, jobs).find((job) => job.id === targetJobId)
      if (!original) return stripped
      stripped.push({ ...original, nodeIds: sortedSelected })
    }
    return renumberJobNames(stripped)
  }

  const usedIds = new Set(stripped.map((job) => job.id))
  const newJob = makeManualJob(sortedSelected, stripped.length, usedIds)
  const selectedStart = orderIndex.get(sortedSelected[0]!) ?? 0
  const insertAt = stripped.findIndex((job) => {
    const first = job.nodeIds[0]
    return first != null && (orderIndex.get(first) ?? Number.MAX_SAFE_INTEGER) > selectedStart
  })
  const nextJobs = [...stripped]
  nextJobs.splice(insertAt < 0 ? nextJobs.length : insertAt, 0, newJob)
  return renumberJobNames(nextJobs)
}

export interface MoveLeafToJobResult {
  manualCutOrder: string[]
  manualJobs: Job[]
}

export function moveLeafToJob(
  cutOrder: CutOrderResult,
  jobs: Job[] | null,
  leafId: string,
  targetJobId: string,
  targetLeafId: string,
  before: boolean,
): MoveLeafToJobResult {
  const currentOrder = orderedLeafIds(cutOrder)
  if (leafId === targetLeafId || !currentOrder.includes(leafId) || !currentOrder.includes(targetLeafId)) {
    return {
      manualCutOrder: currentOrder,
      manualJobs: normalizeManualJobs(cutOrder, jobs),
    }
  }

  const manualCutOrder = [...currentOrder]
  const fromIndex = manualCutOrder.indexOf(leafId)
  manualCutOrder.splice(fromIndex, 1)
  const targetIndex = manualCutOrder.indexOf(targetLeafId)
  manualCutOrder.splice(targetIndex + (before ? 0 : 1), 0, leafId)

  const baseJobs = normalizeManualJobs(cutOrder, jobs)
  const movedJob = baseJobs.find((job) => job.id === targetJobId)
  if (!movedJob) {
    return {
      manualCutOrder,
      manualJobs: baseJobs,
    }
  }

  const nextJobs = baseJobs
    .map((job) => ({ ...job, nodeIds: job.nodeIds.filter((nodeId) => nodeId !== leafId) }))
    .filter((job) => job.nodeIds.length > 0 || job.id === targetJobId)
  const targetJob = nextJobs.find((job) => job.id === targetJobId)
  if (!targetJob) {
    return {
      manualCutOrder,
      manualJobs: nextJobs,
    }
  }

  const insertIndex = targetJob.nodeIds.indexOf(targetLeafId)
  targetJob.nodeIds.splice(insertIndex < 0 ? targetJob.nodeIds.length : insertIndex + (before ? 0 : 1), 0, leafId)

  const leafById = new Map(cutOrder.sequence.map((leaf) => [leaf.nodeId, leaf]))
  const nextCutOrder: CutOrderResult = {
    ...cutOrder,
    sequence: manualCutOrder
      .map((nodeId, index) => {
        const leaf = leafById.get(nodeId)
        return leaf ? { ...leaf, index } : null
      })
      .filter((leaf): leaf is CutOrderResult['sequence'][number] => Boolean(leaf)),
  }

  return {
    manualCutOrder,
    manualJobs: normalizeManualJobs(nextCutOrder, nextJobs),
  }
}

interface LeafWithBounds {
  nodeId: string
  bounds: Bounds
  centroid: { x: number; y: number }
  cutIndex: number
  forceOwnJob: boolean
  /** Topmost SVG group ancestor's id — used as the primary clustering key so
   *  everything imported together defaults to one job. Null if the leaf has
   *  no group ancestor (loose top-level shape). */
  topGroupId: string | null
}

/** Walk up parentId to the topmost `type === 'group'` ancestor. Returns null
 *  if the leaf has no group ancestor. We use the *topmost* (not nearest) group
 *  so deeply nested imports still land in a single job. */
function topGroupAncestor(
  nodeId: string,
  nodesById: Record<string, CanvasNode>,
): string | null {
  let topGroup: string | null = null
  let cursor: string | null = nodeId
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const node: CanvasNode | undefined = nodesById[cursor]
    if (!node) break
    if (node.type === 'group') topGroup = cursor
    cursor = node.parentId
  }
  return topGroup
}

/** Build per-leaf geometry from the cut order, dropping leaves without bounds
 *  (e.g. invisible nodes) so every clustering step has real coordinates. */
function leavesWithGeometry(
  cutOrder: CutOrderResult,
  nodesById: Record<string, CanvasNode>,
  manualJobs: Job[] | null,
): LeafWithBounds[] {
  const forceFlag = new Map<string, boolean>()
  if (manualJobs) {
    for (const j of manualJobs) {
      if (j.forceOwnJob) for (const id of j.nodeIds) forceFlag.set(id, true)
    }
  }

  const out: LeafWithBounds[] = []
  for (const leaf of cutOrder.sequence) {
    const node = nodesById[leaf.nodeId]
    if (!node) continue
    const bounds = getNodePreviewBounds(node, nodesById)
    if (!bounds) continue
    out.push({
      nodeId: leaf.nodeId,
      bounds,
      centroid: boundsCentroid(bounds),
      cutIndex: leaf.index,
      forceOwnJob: forceFlag.get(leaf.nodeId) ?? false,
      topGroupId: topGroupAncestor(leaf.nodeId, nodesById),
    })
  }
  return out
}

/** Auto-partition leaves into jobs.
 *
 *  Default rule is **one SVG group = one job**: leaves that share a topmost
 *  group ancestor cluster together. Loose leaves (no group ancestor) each form
 *  their own singleton. A second pass then merges group-clusters whose bounds
 *  centroids are within `clusterRadius` of each other — this collapses two
 *  adjacent imports into a single job when the user clearly intends them as a
 *  unit. Leaves flagged `forceOwnJob` stay as singletons regardless.
 *
 *  The old per-leaf proximity pass is gone: per-leaf clustering fragments
 *  grouped SVG imports into dozens of tiny jobs, which was the whole reason
 *  the feedback came in.
 */
function autoPartition(
  leaves: LeafWithBounds[],
  clusterRadius: number,
): { groups: LeafWithBounds[][]; bigSpannerNodeIds: Set<string> } {
  // Big-spanner detection is still available for manual overrides (the
  // context menu surfaces it) but we no longer *auto*-promote spanners to
  // their own job — most "spanners" in practice are the passe-partout drawn
  // together with the inner shapes, and the user already grouped them in the
  // SVG. The set stays empty here; `forceOwnJob` handles explicit promotion.
  const bigSpannerNodeIds = new Set<string>()

  // Bucket by topmost group ancestor; loose leaves go to a synthetic key
  // per-nodeId so each loose shape is its own singleton.
  const buckets = new Map<string, LeafWithBounds[]>()
  const singletons: LeafWithBounds[] = []
  for (const leaf of leaves) {
    if (leaf.forceOwnJob) {
      singletons.push(leaf)
      continue
    }
    const key = leaf.topGroupId ?? `__loose__${leaf.nodeId}`
    const list = buckets.get(key) ?? []
    list.push(leaf)
    buckets.set(key, list)
  }

  // Merge adjacent buckets by centroid proximity. Each bucket's centroid is
  // the centroid of its union-bounds — more stable than averaging leaf
  // centroids for non-uniform groups.
  const bucketEntries = [...buckets.values()]
  const bucketCentroids = bucketEntries.map((bucket) => {
    const union = unionBounds(bucket.map((l) => l.bounds))!
    return boundsCentroid(union)
  })
  const uf = new UnionFind(bucketEntries.length)
  for (let i = 0; i < bucketEntries.length; i += 1) {
    for (let j = i + 1; j < bucketEntries.length; j += 1) {
      if (centroidDistance(bucketCentroids[i], bucketCentroids[j]) <= clusterRadius) {
        uf.union(i, j)
      }
    }
  }

  const mergedByRoot = new Map<number, LeafWithBounds[]>()
  for (let i = 0; i < bucketEntries.length; i += 1) {
    const root = uf.find(i)
    const list = mergedByRoot.get(root) ?? []
    list.push(...bucketEntries[i])
    mergedByRoot.set(root, list)
  }

  const allGroups: LeafWithBounds[][] = []
  for (const leaf of singletons) allGroups.push([leaf])
  for (const group of mergedByRoot.values()) allGroups.push(group)

  // Stable order: by the minimum cut-index inside each group.
  allGroups.sort(
    (a, b) =>
      Math.min(...a.map((l) => l.cutIndex)) - Math.min(...b.map((l) => l.cutIndex)),
  )
  for (const g of allGroups) g.sort((a, b) => a.cutIndex - b.cutIndex)

  return { groups: allGroups, bigSpannerNodeIds }
}

export interface ComputeJobsResult {
  jobs: ComputedJob[]
  /** Auto-derived partition regardless of manual override; the UI shows
   *  "Reset to auto" only when this diverges from `jobs`. */
  autoJobs: ComputedJob[]
}

export function computeJobs(
  cutOrder: CutOrderResult,
  nodesById: Record<string, CanvasNode>,
  settings: MachiningSettings,
  artboard: ArtboardState,
): ComputeJobsResult {
  const leaves = leavesWithGeometry(cutOrder, nodesById, settings.manualJobs)
  const clusterRadius = resolveJobClusterRadius(settings.jobClusterRadius, artboard)
  const { groups: autoGroupsRaw, bigSpannerNodeIds } = autoPartition(leaves, clusterRadius)

  const finalize = (
    groups: LeafWithBounds[][],
    fromManual: boolean,
    nameHint: (index: number) => string,
    anchorFor: (nodeIds: string[]) => PathAnchor,
    idFor: (index: number, nodeIds: string[]) => string,
    forceFlagFor: (nodeIds: string[]) => boolean,
  ): ComputedJob[] => {
    return groups.map((group, index) => {
      const nodeIds = group.map((l) => l.nodeId)
      const bounds = unionBounds(group.map((l) => l.bounds))!
      const anchor = anchorFor(nodeIds)
      const anchorPt = anchorPoint(anchor, bounds)
      return {
        id: idFor(index, nodeIds),
        name: nameHint(index),
        nodeIds,
        pathAnchor: anchor,
        forceOwnJob: forceFlagFor(nodeIds),
        boundsMm: bounds,
        anchorPointMm: anchorPt,
        crossOffsetFromArtboardBL: {
          x: anchorPt.x,
          // Artboard y grows downward in the editor; the user measures up from the
          // bottom edge, so flip.
          y: artboard.height - anchorPt.y,
        },
        isBigSpanner: nodeIds.some((id) => bigSpannerNodeIds.has(id)) || forceFlagFor(nodeIds),
        fromManualOverride: fromManual,
      }
    })
  }

  // Pre-compute the auto result so the UI can show "Reset to auto".
  const autoJobs = finalize(
    autoGroupsRaw,
    false,
    (i) => `Job ${i + 1}`,
    () => 'Center',
    (i, nodeIds) => stableJobId(nodeIds, i),
    (nodeIds) => nodeIds.some((id) => bigSpannerNodeIds.has(id)),
  )

  if (!settings.manualJobs || settings.manualJobs.length === 0) {
    return { jobs: autoJobs, autoJobs }
  }

  // Apply the manual partition — each job keeps its user-set anchor and name
  // while re-deriving bounds from current node positions.
  const normalizedManualJobs = normalizeManualJobs(cutOrder, settings.manualJobs)
  const byId = new Map(leaves.map((l) => [l.nodeId, l]))
  const manualPairs = normalizedManualJobs
    .map((job) => ({
      job,
      group: job.nodeIds.map((id) => byId.get(id)).filter((x): x is LeafWithBounds => !!x),
    }))
    .filter((pair) => pair.group.length > 0)
  const manualGroups: LeafWithBounds[][] = manualPairs.map((pair) => pair.group)

  const manualJobsByIndex = manualPairs.map((pair) => pair.job)
  const manualJobs = finalize(
    manualGroups,
    true,
    (i) => manualJobsByIndex[i]?.name ?? `Job ${i + 1}`,
    (nodeIds) => {
      const idx = manualJobsByIndex.findIndex((mj) =>
        mj.nodeIds.every((id) => nodeIds.includes(id)),
      )
      return manualJobsByIndex[idx]?.pathAnchor ?? 'Center'
    },
    (i, nodeIds) => manualJobsByIndex[i]?.id ?? stableJobId(nodeIds, i),
    (nodeIds) =>
      manualJobsByIndex.find((mj) => mj.nodeIds.every((id) => nodeIds.includes(id)))
        ?.forceOwnJob ?? false,
  )

  return { jobs: manualJobs, autoJobs }
}
