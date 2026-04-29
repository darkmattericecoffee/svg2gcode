import {
  prepareSvgDocument,
  createArtObject,
  composeArtObjectsSvg,
  getDerivedOperationsForArtObjects,
  engraveTypeToFillMode,
  splitCompositeElementId,
  type ArtObject,
  type FrontendOperation,
  type JobSpec,
  type Settings,
  type EngraveType as BridgeEngraveType,
} from "@svg2gcode/bridge"

import type {
  ArtboardState,
  CanvasNode,
  CncMetadata,
  GroupNode,
  MachiningSettings,
} from "../types/editor"
import { mergeCncMetadata } from "./cncMetadata"
import { buildCenterlineExportNodes, subtreeHasActiveCenterline } from "./centerline"
import { getSubtreeIds, isGroupNode } from "./editorTree"
import { getNodeSize } from "./nodeDimensions"
import { getNodePreviewBounds, type Bounds } from "./nodeBounds"
import { exportToSVG } from "./svgExport"
import { buildBridgeSettings, resolveEffectiveMaxStepdown } from "./bridgeSettingsAdapter"
import { type CutOrderResult } from "./cutOrder"
import { computeCutPlan, type ComputedJob } from "./jobs"

/**
 * Convert the editor's canvas state into bridge ArtObjects for GCode generation.
 *
 * For each root-level group with an `originalSvg`:
 * 1. Parse the original SVG through the WASM bridge (prepareSvgDocument)
 * 2. Create an ArtObject with auto-assigned element assignments
 * 3. Override element assignments based on the editor's CNC metadata
 *
 * For root nodes without `originalSvg` (manually created shapes), we export
 * them to SVG first, then run the same pipeline.
 */
export async function editorStateToArtObjects(
  nodesById: Record<string, CanvasNode>,
  rootIds: string[],
  artboard: ArtboardState,
  machiningSettings: MachiningSettings,
  baseSettings: Settings,
): Promise<{ artObjects: ArtObject[]; skippedCompositeIds: Set<string> }> {
  const settings = buildBridgeSettings(baseSettings, artboard, machiningSettings)
  const artObjects: ArtObject[] = []
  const skippedCompositeIds = new Set<string>()

  const { cutOrder, jobs } = computeCutPlan(rootIds, nodesById, machiningSettings, artboard)
  const cutOrderLookup = buildCutOrderLookup(cutOrder)
  const jobIdByNodeId = machiningSettings.jobsEnabled
    ? buildJobLookup(jobs)
    : new Map<string, string>()

  for (const rootId of rootIds) {
    const rootNode = nodesById[rootId]
    if (!rootNode || !rootNode.visible) continue

    const exportInfo = getSvgTextForNode(rootNode, rootId, nodesById, artboard, machiningSettings)
    if (!exportInfo) continue

    const preparedSvg = await prepareSvgDocument(exportInfo.svgText)

    const defaultEngraveType = resolveDefaultEngraveType(rootNode)
    const nodeSize = getNodeSize(rootNode, nodesById)
    const usesGeneratedCenterlineSvg = exportInfo.usesGeneratedCenterlineSvg

    // For rotated roots, use the rotated AABB for placement and dimensions.
    // `nodeSize` ignores rotation, so falls back to the un-rotated box; the
    // rotated SVG content from `buildRotationAlignedExport` fits the AABB.
    const rotatedAabb: Bounds | null = isRotated(rootNode)
      ? getNodePreviewBounds(rootNode, nodesById)
      : null
    const placementWidth = rotatedAabb ? rotatedAabb.maxX - rotatedAabb.minX : nodeSize.width
    const placementHeight = rotatedAabb ? rotatedAabb.maxY - rotatedAabb.minY : nodeSize.height
    const placementOriginX = rotatedAabb ? rotatedAabb.minX : rootNode.x
    const placementOriginY = rotatedAabb ? rotatedAabb.minY : rootNode.y

    // Expand grid nodes into N×M individual art objects
    const grid = rootNode.gridMetadata
    const rows = grid ? Math.max(1, grid.rows) : 1
    const cols = grid ? Math.max(1, grid.cols) : 1
    const rowGap = grid ? grid.rowGap : 0
    const colGap = grid ? grid.colGap : 0

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cellId = rows === 1 && cols === 1 ? rootId : `${rootId}-grid-${r}-${c}`
        const artObject = createArtObject({
          artObjectId: cellId,
          name: rows === 1 && cols === 1 ? rootNode.name : `${rootNode.name} [${r + 1},${c + 1}]`,
          preparedSvg,
          settings,
          defaultEngraveType,
          existingArtObjects: artObjects,
        })

        artObject.widthMm = placementWidth
        artObject.heightMm = placementHeight
        artObject.placementX = placementOriginX + c * (placementWidth + colGap)
        const cellCanvasY = placementOriginY + r * (placementHeight + rowGap)
        artObject.placementY = artboard.height - cellCanvasY - placementHeight

        // For generator nodes and synthesized shapes (no originalSvg), getSvgTextForNode
        // calls exportToSVG with an artboard-sized viewport (e.g. viewBox="0 0 600 500").
        // parseSvgDocumentMetrics then sets svgMetrics.width=600 instead of the shape's
        // actual coordinate width (~100mm), causing composeArtObjectsSvg to compute
        // scaleX = widthMm / 600 ≈ 0.17 — squashing the shape and corrupting its position.
        //
        // Fix: override svgMetrics so width/height match the SVG content's *post-transform*
        // extent in user units. exportToSVG wraps each node with
        // `transform="translate(x y) scale(sx sy)"` around the base path data, so the
        // content span in the SVG is `baseWidth * |scaleX|` — i.e. nodeSize.width. Using
        // nodeSize.baseWidth here double-scales shapes whose wrapper carries scaleX != 1
        // (e.g. centerline wrappers, which inherit the source node's scale), because the
        // bridge then computes scaleX_bridge = widthMm / baseWidth = |scaleX| on top of
        // the transform that's already baked into the SVG. Generators stay at scaleX=1
        // (parametric resize rewrites the underlying data), so for them nodeSize.width ==
        // nodeSize.baseWidth and this change is a no-op.
        // The originalSvg fast path is only used when the root has no rotation;
        // otherwise we went through buildRotationAlignedExport (an artboard-sized
        // SVG with content shifted to fit (0,0)-(placement size)), and need the
        // same svgMetrics override the centerline / synthesized-shape paths use.
        const hasOriginalSvg = isGroupNode(rootNode)
          && Boolean((rootNode as GroupNode).originalSvg)
          && !usesGeneratedCenterlineSvg
          && !isRotated(rootNode)
        if ((usesGeneratedCenterlineSvg || !hasOriginalSvg) && placementWidth > 0 && placementHeight > 0) {
          artObject.svgMetrics = {
            x: 0,
            y: 0,
            width: placementWidth,
            height: placementHeight,
            widthMm: placementWidth,
            heightMm: placementHeight,
            aspectRatio: placementWidth / placementHeight,
          }
        }

        applyEditorCncMetadata(
          artObject,
          exportInfo.metadataRootNode,
          exportInfo.metadataNodesById,
          machiningSettings,
          cutOrderLookup,
          jobIdByNodeId,
          artObjects.length,
          { skippedCompositeIds, sourceNodesById: nodesById },
        )
        artObjects.push(artObject)
      }
    }
  }

  return { artObjects, skippedCompositeIds }
}

/** A node is effectively skipped if it (or any ancestor) has `skip=true`. */
function isEffectivelySkipped(
  nodeId: string,
  nodesById: Record<string, CanvasNode>,
): boolean {
  let cur: CanvasNode | undefined = nodesById[nodeId]
  while (cur) {
    if (cur.skip) return true
    if (!cur.parentId) break
    cur = nodesById[cur.parentId]
  }
  return false
}

interface CutOrderLookup {
  indexByNodeId: Map<string, number>
  groupIdByNodeId: Map<string, string>
}

function buildCutOrderLookup(cutOrder: CutOrderResult): CutOrderLookup {
  const indexByNodeId = new Map<string, number>()
  const groupIdByNodeId = new Map<string, string>()
  for (const leaf of cutOrder.sequence) {
    indexByNodeId.set(leaf.nodeId, leaf.index)
    groupIdByNodeId.set(leaf.nodeId, leaf.groupId)
  }
  return { indexByNodeId, groupIdByNodeId }
}

function buildJobLookup(jobs: ComputedJob[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const job of jobs) {
    for (const nodeId of job.nodeIds) out.set(nodeId, job.id)
  }
  return out
}

/**
 * Full GCode generation pipeline: editor state → ArtObjects → composed SVG → operations.
 * Returns the inputs needed for `generateEngravingJob`.
 */
export async function prepareGenerationInputs(
  nodesById: Record<string, CanvasNode>,
  rootIds: string[],
  artboard: ArtboardState,
  machiningSettings: MachiningSettings,
  baseSettings: Settings,
) {
  const { artObjects } = await editorStateToArtObjects(
    nodesById,
    rootIds,
    artboard,
    machiningSettings,
    baseSettings,
  )

  if (artObjects.length === 0) {
    throw new Error("No visible objects on the artboard to generate GCode from.")
  }

  // Build jobs from the current cut-order + scene. When jobsEnabled is false,
  // we pass `null` so `buildBridgeSettings` keeps the legacy single-anchor path.
  const { jobs: computedJobs } = computeCutPlan(rootIds, nodesById, machiningSettings, artboard)

  // Skipped elements have already had their assignments deleted in
  // `applyEditorCncMetadata`, so they're absent from the bridge's grouping +
  // operation derivation here. Anchor / job calculations above ran on the full
  // scene (including skipped nodes), so the layout stays aligned.
  const operations = getDerivedOperationsForArtObjects(artObjects)
  const jobSpecs = machiningSettings.jobsEnabled
    ? jobSpecsFromComputedJobs(computedJobs, operations, artObjects)
    : null

  const settings = buildBridgeSettings(baseSettings, artboard, machiningSettings, jobSpecs)
  const composedSvg = ensurePocketFillsOnComposedSvg(composeArtObjectsSvg(artObjects, settings))
  const deepestTargetDepth = operations.reduce(
    (max, operation) => Math.max(max, operation.target_depth_mm),
    0,
  )
  const effectiveMaxStepdown = resolveEffectiveMaxStepdown(
    machiningSettings,
    deepestTargetDepth,
  )

  if (effectiveMaxStepdown != null) {
    settings.engraving.max_stepdown = effectiveMaxStepdown
  }

  return { normalized_svg: composedSvg, settings, operations }
}

/**
 * Resolve ComputedJob → JobSpec.
 *
 * Most operations carry an explicit `jobId` stamped during
 * `applyEditorCncMetadata`. For the minority that don't (e.g. synthesized
 * centerline exports whose leaf nodeIds weren't in the editor's cut-order
 * sequence), we recover by looking at the operation's `assigned_element_ids`:
 * each composite element id starts with `<artObjectId>::…`, and every
 * ComputedJob's `nodeIds` contains the owning leaf. If that still doesn't
 * match, we fall back to the first ComputedJob so generation stays viable
 * rather than exploding mid-export.
 *
 * Callers should only invoke this when `jobsEnabled === true`; returning
 * `null` signals "no jobs to emit".
 */
export function jobSpecsFromComputedJobs(
  computedJobs: ComputedJob[],
  operations: FrontendOperation[],
  _artObjects: ArtObject[],
): JobSpec[] | null {
  if (computedJobs.length === 0 || operations.length === 0) return null

  const jobIdsKnown = new Set(computedJobs.map((job) => job.id))
  const jobIdByNodeId = new Map<string, string>()
  for (const job of computedJobs) {
    for (const nodeId of job.nodeIds) jobIdByNodeId.set(nodeId, job.id)
  }

  const resolveJobId = (operation: FrontendOperation): string => {
    if (operation.jobId && jobIdsKnown.has(operation.jobId)) return operation.jobId
    // Recovery path: inspect the operation's assigned element ids.
    // `buildCompositeElementId` joins `<artObjectId>::<localElementId>`, and the
    // artObjectId == the editor node id. If any assigned leaf maps to a job,
    // claim that job.
    for (const compositeId of operation.assigned_element_ids) {
      const artObjectId = compositeId.split("::")[0]
      if (!artObjectId) continue
      const jobId = jobIdByNodeId.get(artObjectId)
      if (jobId) return jobId
    }
    // Last-resort: dump it into the first job so generation proceeds.
    console.warn(
      `[bridgeAdapter] Operation ${operation.id} has no resolvable jobId; assigning to ${computedJobs[0]!.id}.`,
    )
    return computedJobs[0]!.id
  }

  const operationsByJobId = new Map<string, string[]>()
  for (const operation of operations) {
    const jobId = resolveJobId(operation)
    const list = operationsByJobId.get(jobId) ?? []
    list.push(operation.id)
    operationsByJobId.set(jobId, list)
  }

  return computedJobs.map((job) => {
    const snapped =
      job.anchorAlignment &&
      (job.anchorAlignment.sharedX != null || job.anchorAlignment.sharedY != null)
    return {
      id: job.id,
      name: job.name,
      operation_ids: operationsByJobId.get(job.id) ?? [],
      path_anchor: job.pathAnchor,
      cross_offset_from_artboard_bl: [
        job.crossOffsetFromArtboardBL.x,
        job.crossOffsetFromArtboardBL.y,
      ],
      is_big_spanner: job.isBigSpanner,
      anchor_point_override: snapped
        ? [job.anchorPointMm.x, job.anchorPointMm.y]
        : null,
    }
  })
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

interface SvgTextForNode {
  svgText: string
  metadataRootNode: CanvasNode
  metadataNodesById: Record<string, CanvasNode>
  usesGeneratedCenterlineSvg: boolean
}

function isRotated(node: CanvasNode): boolean {
  return node.rotation !== 0
}

function buildRotationAlignedExport(
  rootId: string,
  sourceNodes: Record<string, CanvasNode>,
  artboard: ArtboardState,
  preserveAttrs: { forcePocketFill: boolean },
): { svgText: string; nodesById: Record<string, CanvasNode>; rootNode: CanvasNode } | null {
  const subtreeIds = getSubtreeIds(rootId, sourceNodes)
  const sourceRoot = sourceNodes[rootId]
  if (!sourceRoot) return null

  // Compute the root's local AABB after rotation/scale, with translate zeroed.
  // This is the bounding box of the rotated content in the SVG's coordinate space.
  const localProbeRoot = { ...sourceRoot, x: 0, y: 0 }
  const localProbeNodes: Record<string, CanvasNode> = {}
  for (const id of subtreeIds) {
    localProbeNodes[id] = id === rootId ? localProbeRoot : sourceNodes[id]!
  }
  const localBounds = getNodePreviewBounds(localProbeRoot, localProbeNodes)
  if (!localBounds) return null

  // Shift the root so the rotated content's AABB top-left lands on (0, 0)
  // in the exported SVG. The bridge expects svgMetrics to describe content
  // starting at (0, 0).
  const exportRoot: CanvasNode = {
    ...sourceRoot,
    x: -localBounds.minX,
    y: -localBounds.minY,
  }
  const exportNodes: Record<string, CanvasNode> = {}
  for (const id of subtreeIds) {
    exportNodes[id] = id === rootId ? exportRoot : sourceNodes[id]!
  }

  const svgText = exportToSVG(
    exportNodes,
    [rootId],
    { ...artboard, x: 0, y: 0 },
    { forcePocketFill: preserveAttrs.forcePocketFill },
  )
  return { svgText, nodesById: exportNodes, rootNode: exportRoot }
}

function getSvgTextForNode(
  node: CanvasNode,
  nodeId: string,
  nodesById: Record<string, CanvasNode>,
  artboard: ArtboardState,
  machiningSettings: MachiningSettings,
): SvgTextForNode | null {
  if (subtreeHasActiveCenterline(node, nodesById)) {
    const exportNodes = buildCenterlineExportNodes(nodeId, nodesById, {
      toolDiameter: machiningSettings.toolDiameter,
    })
    const exportRoot = exportNodes.nodesById[nodeId]
    if (exportRoot) {
      exportNodes.nodesById[nodeId] = { ...exportRoot, x: 0, y: 0 } as CanvasNode
    }

    return {
      svgText: exportToSVG(
        exportNodes.nodesById,
        [nodeId],
        { ...artboard, x: 0, y: 0 },
        { forcePocketFill: true },
      ),
      metadataRootNode: exportNodes.nodesById[nodeId] ?? exportNodes.rootNode,
      metadataNodesById: exportNodes.nodesById,
      usesGeneratedCenterlineSvg: true,
    }
  }

  // Prefer the stored original SVG from import (but not for generator groups —
  // those need per-child export so each shape becomes a separate operation).
  // Skip the fast path when the root has been rotated: the raw originalSvg has
  // no rotation applied, and the bridge's placement assumes content runs from
  // (0,0) to (widthMm,heightMm) — without baking rotation in, the cuts would
  // land at the un-rotated position.
  if (isGroupNode(node) && node.originalSvg && !(node as GroupNode).generatorMetadata && !isRotated(node)) {
    return {
      svgText: node.originalSvg,
      metadataRootNode: node,
      metadataNodesById: nodesById,
      usesGeneratedCenterlineSvg: false,
    }
  }

  const aligned = buildRotationAlignedExport(nodeId, nodesById, artboard, { forcePocketFill: true })
  if (!aligned) return null

  return {
    svgText: aligned.svgText,
    metadataRootNode: aligned.rootNode,
    metadataNodesById: aligned.nodesById,
    usesGeneratedCenterlineSvg: false,
  }
}

function resolveDefaultEngraveType(node: CanvasNode): BridgeEngraveType {
  const engraveType = node.cncMetadata?.engraveType
  if (engraveType === "pocket" || engraveType === "outline") {
    return engraveType
  }
  if (engraveType === "contour") {
    return "outline"
  }
  // 'plunge' maps to pocket — tiny circles will produce a plunge-like operation
  if (engraveType === "plunge") {
    return "pocket"
  }
  return "pocket"
}

/**
 * Walk the editor's node subtree and apply CNC metadata (cutDepth, engraveType)
 * onto the ArtObject's element assignments.
 *
 * Since the editor's node IDs and the bridge's element IDs (from data-s2g-id)
 * are independent, we match by traversal order: leaf elements in both trees
 * come from the same SVG and appear in the same document order.
 */
function applyEditorCncMetadata(
  artObject: ArtObject,
  rootNode: CanvasNode,
  nodesById: Record<string, CanvasNode>,
  machiningSettings: MachiningSettings,
  cutOrder?: CutOrderLookup,
  jobIdByNodeId?: Map<string, string>,
  artObjectOrdinal = 0,
  skipTracking?: {
    skippedCompositeIds: Set<string>
    /** The user-facing scene tree, used to walk parent chains for skip
     *  inheritance. `nodesById` may be a synthesized export tree (centerline /
     *  rotation-aligned) — its leaves still reference original node ids, so we
     *  resolve skip against the original scene to get the right answer. */
    sourceNodesById: Record<string, CanvasNode>
  },
) {
  // Collect leaf nodes with CNC metadata in document order
  const leafMetadata = collectLeafCncMetadata(rootNode, nodesById)
  const intrinsicEngraveTypes = getIntrinsicEngraveTypes(artObject)

  // The bridge's selectable element IDs are in document order too
  const compositeIds = Object.keys(artObject.elementAssignments)

  // If we have metadata from the editor, apply it positionally
  // If the editor has metadata on the root group, apply it as default to all elements
  const rootDepth = rootNode.cncMetadata?.cutDepth ?? machiningSettings.defaultDepthMm
  const rootEngraveType = resolveDefaultEngraveType(rootNode)
  const rootFillMode = engraveTypeToFillMode(rootEngraveType)

  // Stride ensures different art objects (e.g. grid cells) never interleave even
  // when their editor-leaf indices coincide.
  const ordinalStride = 1_000_000
  const ordinalOffset = artObjectOrdinal * ordinalStride

  for (let i = 0; i < compositeIds.length; i++) {
    const compositeId = compositeIds[i]!
    const assignment = artObject.elementAssignments[compositeId]
    if (!assignment) continue

    // Skip-tracking has to happen before we apply CNC metadata. When an element
    // is skipped, we delete its assignment entirely so the bridge's grouping
    // pass (`groupAssignmentsForIds`) never folds it into an operation. This is
    // necessary because the bridge bundles every element sharing the same
    // jobId+cutOrderGroupId+depth+engraveType+fillMode into one operation —
    // dropping such an op only when ALL its members are skipped lets partial-
    // skips slip through (e.g. skipping 4 of 9 letters in a single text fill).
    const leafMeta = leafMetadata[i]
    if (skipTracking) {
      const skipNodeId = leafMeta?.nodeId ?? rootNode.id
      if (isEffectivelySkipped(skipNodeId, skipTracking.sourceNodesById)) {
        skipTracking.skippedCompositeIds.add(compositeId)
        delete artObject.elementAssignments[compositeId]
        continue
      }
    }

    // Check if there's a positional match from editor leaf metadata
    if (leafMeta) {
      assignment.targetDepthMm = leafMeta.cutDepth ?? rootDepth
      assignment.engraveType = leafMeta.engraveType
        ?? intrinsicEngraveTypes[compositeId]
        ?? rootEngraveType
      assignment.fillMode = engraveTypeToFillMode(assignment.engraveType) ?? rootFillMode
    } else {
      // Fall back to root defaults
      assignment.targetDepthMm = rootDepth
      assignment.engraveType = intrinsicEngraveTypes[compositeId] ?? rootEngraveType
      assignment.fillMode = engraveTypeToFillMode(assignment.engraveType) ?? rootFillMode
    }

    if (cutOrder) {
      const leafNodeId = leafMeta?.nodeId
      const baseIndex = leafNodeId ? cutOrder.indexByNodeId.get(leafNodeId) : undefined
      const baseGroupId = leafNodeId ? cutOrder.groupIdByNodeId.get(leafNodeId) : undefined
      // Scope group id by artObject so grid cells / multiple roots stay separate.
      assignment.cutOrderGroupId = baseGroupId
        ? `${artObject.id}::${baseGroupId}`
        : artObject.id
      assignment.cutOrderIndex = ordinalOffset + (baseIndex ?? i)
      if (leafNodeId && jobIdByNodeId?.has(leafNodeId)) {
        assignment.jobId = jobIdByNodeId.get(leafNodeId)
      }
    }
  }
}

interface LeafMeta {
  nodeId: string
  cutDepth: number | undefined
  engraveType: BridgeEngraveType | null
}

function collectLeafCncMetadata(
  node: CanvasNode,
  nodesById: Record<string, CanvasNode>,
  inheritedMetadata?: CncMetadata,
  isRoot = true,
): LeafMeta[] {
  const effectiveInherited = isRoot
    ? inheritedMetadata
    : mergeCncMetadata(node.cncMetadata, inheritedMetadata)

  if (isGroupNode(node)) {
    const result: LeafMeta[] = []
    for (const childId of (node as GroupNode).childIds) {
      const child = nodesById[childId]
      if (child && child.visible) {
        result.push(...collectLeafCncMetadata(child, nodesById, effectiveInherited, false))
      }
    }
    return result
  }

  // Leaf node — use leaf/intermediate metadata. Root metadata is applied by
  // applyEditorCncMetadata as a fallback, after SVG paint-based defaults.
  const metadata = mergeCncMetadata(node.cncMetadata, effectiveInherited) ?? {}
  const editorType = metadata.engraveType
  let bridgeType: BridgeEngraveType | null = null
  if (editorType === "contour" || editorType === "outline") {
    bridgeType = "outline"
  } else if (editorType === "pocket" || editorType === "plunge") {
    bridgeType = "pocket"
  }

  return [{
    nodeId: node.id,
    cutDepth: metadata.cutDepth,
    engraveType: bridgeType,
  }]
}

function getIntrinsicEngraveTypes(artObject: ArtObject): Record<string, BridgeEngraveType> {
  const result: Record<string, BridgeEngraveType> = {}
  const compositeByLocalId = new Map(
    Object.keys(artObject.elementAssignments).map((compositeId) => [
      splitCompositeElementId(compositeId).elementId,
      compositeId,
    ]),
  )
  const parser = new DOMParser()
  const doc = parser.parseFromString(artObject.preparedSvg.normalized_svg, "image/svg+xml")
  if (doc.getElementsByTagName("parsererror").length > 0) {
    return result
  }

  for (const element of Array.from(doc.querySelectorAll("[data-s2g-id]"))) {
    const localId = element.getAttribute("data-s2g-id")
    if (!localId) continue

    const compositeId = compositeByLocalId.get(localId)
    if (!compositeId) continue

    const fill = readInheritedPaint(element, "fill", "black")
    const stroke = readInheritedPaint(element, "stroke", "none")
    result[compositeId] = isNonePaint(fill) && !isNonePaint(stroke) ? "outline" : "pocket"
  }

  return result
}

function readInheritedPaint(element: Element, property: "fill" | "stroke", fallback: string): string {
  let current: Element | null = element
  while (current) {
    const styleValue = readStyleProperty(current.getAttribute("style"), property)
    if (styleValue != null) return styleValue
    const attrValue = current.getAttribute(property)
    if (attrValue != null) return attrValue
    current = current.parentElement
  }
  return fallback
}

function isNonePaint(value: string | null | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase()
  return normalized === "" || normalized === "none" || normalized === "transparent"
}

// ─── Composed-SVG pocket-fill safety net ──────────────────────────────────────

/**
 * The Rust CAM turtle (see `lib/src/converter/cam.rs::CamTurtle::flush_subpath`)
 * only registers a closed subpath as a pocket-able fill shape when
 * `current_paint.fill` is truthy. SVGs that reach this point with
 * `fill="none"` on a Pocket-assigned element silently fall through to a
 * contour trace — every stroke-only closed shape (generator output like
 * tenons/dominos, Illustrator outline exports, etc.) hits this trap.
 *
 * Earlier pipeline stages try to emit fills correctly (see `svgExport.ts`
 * with `forcePocketFill: true`), but the `originalSvg` fast path in
 * `getSvgTextForNode` sends the raw import straight through and bypasses
 * that. This runs as the last step before WASM, after
 * `annotateAssignmentMetadata` has already stamped `data-engrave-type` on
 * every leaf, so one DOM walk catches every code path.
 *
 * Rule: for every element marked `data-engrave-type="pocket"`, ensure it
 * has a non-`none` `fill` attribute. We only overwrite when the element's
 * direct fill is unset or `"none"` — explicit user fills (colors, gradient
 * refs) are preserved because the Rust side only cares about fill presence,
 * not fill value.
 */
function ensurePocketFillsOnComposedSvg(svgText: string): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(svgText, "image/svg+xml")

  // Parser errors produce a <parsererror> root — bail out rather than risk
  // corrupting the SVG string.
  if (doc.getElementsByTagName("parsererror").length > 0) {
    return svgText
  }

  let mutated = false
  for (const element of Array.from(doc.querySelectorAll('[data-engrave-type="pocket"]'))) {
    const attrFill = element.getAttribute("fill")
    const styleFill = readStyleProperty(element.getAttribute("style"), "fill")

    // Priority: inline style > attribute. Mirrors CSS specificity.
    const effective = (styleFill ?? attrFill ?? "").trim().toLowerCase()

    if (effective === "" || effective === "none") {
      element.setAttribute("fill", "#000")
      mutated = true
    }
  }

  if (!mutated) return svgText
  return new XMLSerializer().serializeToString(doc)
}

/**
 * Reads a property from an inline CSS style attribute. Returns `null` when
 * the style is missing or the property isn't set. Handles semicolons inside
 * the value conservatively — this is not a full CSS parser, but it covers
 * the shapes that come out of `prepareSvgDocument` (simple `prop: value`
 * declarations separated by `;`).
 */
function readStyleProperty(style: string | null, property: string): string | null {
  if (!style) return null
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":")
    if (colon < 0) continue
    const name = declaration.slice(0, colon).trim().toLowerCase()
    if (name === property) {
      return declaration.slice(colon + 1).trim()
    }
  }
  return null
}
