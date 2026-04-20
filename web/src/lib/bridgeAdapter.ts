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
import { exportToSVG } from "./svgExport"
import { buildBridgeSettings, resolveEffectiveMaxStepdown } from "./bridgeSettingsAdapter"
import { computeCutOrder, type CutOrderResult } from "./cutOrder"
import { computeJobs, type ComputedJob } from "./jobs"

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
): Promise<ArtObject[]> {
  const settings = buildBridgeSettings(baseSettings, artboard, machiningSettings)
  const artObjects: ArtObject[] = []

  const cutOrder = computeCutOrder(
    rootIds,
    nodesById,
    machiningSettings.cutOrderStrategy,
    machiningSettings.manualCutOrder,
  )
  const cutOrderLookup = buildCutOrderLookup(cutOrder)
  const jobIdByNodeId = machiningSettings.jobsEnabled
    ? buildJobLookup(computeJobs(cutOrder, nodesById, machiningSettings, artboard).jobs)
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

        artObject.widthMm = nodeSize.width
        artObject.heightMm = nodeSize.height
        artObject.placementX = rootNode.x + c * (nodeSize.width + colGap)
        const cellCanvasY = rootNode.y + r * (nodeSize.height + rowGap)
        artObject.placementY = artboard.height - cellCanvasY - nodeSize.height

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
        const hasOriginalSvg = isGroupNode(rootNode) && Boolean((rootNode as GroupNode).originalSvg) && !usesGeneratedCenterlineSvg
        if ((usesGeneratedCenterlineSvg || !hasOriginalSvg) && nodeSize.width > 0 && nodeSize.height > 0) {
          artObject.svgMetrics = {
            x: 0,
            y: 0,
            width: nodeSize.width,
            height: nodeSize.height,
            widthMm: nodeSize.width,
            heightMm: nodeSize.height,
            aspectRatio: nodeSize.width / nodeSize.height,
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
        )
        artObjects.push(artObject)
      }
    }
  }

  return artObjects
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
  const artObjects = await editorStateToArtObjects(
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
  const cutOrder = computeCutOrder(
    rootIds,
    nodesById,
    machiningSettings.cutOrderStrategy,
    machiningSettings.manualCutOrder,
  )
  const { jobs: computedJobs } = computeJobs(cutOrder, nodesById, machiningSettings, artboard)

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
 * Resolve ComputedJob → JobSpec by mapping each job's editor nodeIds to the
 * FrontendOperation ids they produced. An editor leaf becomes one or more
 * ArtObject element assignments; each derived operation bundles elements by
 * `cutOrderGroupId` (which embeds the nodeId's cut-order group).
 *
 * When the mapping is ambiguous (no operations can be assigned to a job, or a
 * single operation spans multiple jobs), we return `null` so Rust falls back
 * to single-job emission instead of producing a malformed partition.
 */
export function jobSpecsFromComputedJobs(
  computedJobs: ComputedJob[],
  operations: FrontendOperation[],
  artObjects: ArtObject[],
): JobSpec[] | null {
  if (computedJobs.length <= 1 || operations.length === 0) return null

  const operationsByExplicitJobId = new Map<string, string[]>()
  let explicitCount = 0
  for (const operation of operations) {
    if (!operation.jobId) continue
    explicitCount += 1
    const list = operationsByExplicitJobId.get(operation.jobId) ?? []
    list.push(operation.id)
    operationsByExplicitJobId.set(operation.jobId, list)
  }

  if (explicitCount === operations.length) {
    const specs: JobSpec[] = []
    const assignedOperationIds = new Set<string>()
    for (const job of computedJobs) {
      const operationIdsForJob = operationsByExplicitJobId.get(job.id) ?? []
      if (operationIdsForJob.length === 0) return null
      for (const id of operationIdsForJob) assignedOperationIds.add(id)
      specs.push({
        id: job.id,
        name: job.name,
        operation_ids: operationIdsForJob,
        path_anchor: job.pathAnchor,
        cross_offset_from_artboard_bl: [
          job.crossOffsetFromArtboardBL.x,
          job.crossOffsetFromArtboardBL.y,
        ],
        is_big_spanner: job.isBigSpanner,
      })
    }
    if (assignedOperationIds.size !== operations.length) return null
    return specs
  }

  // Index every operation by its contributing node ids. `cutOrderGroupId` was
  // set in `applyEditorCncMetadata` to `${artObjectId}::${editorGroupId}` — we
  // flatten back to the set of editor nodeIds that composed the operation's
  // elements (via the assignment records on each art object).
  const nodeIdsByOperationId = new Map<string, Set<string>>()
  const elementToNode = new Map<string, string>()
  // Note: we lack a direct element→nodeId map in ArtObject. The `leafMeta`
  // list built during `applyEditorCncMetadata` walks nodes in document order,
  // which matches `Object.keys(elementAssignments)` order — so we can rebuild
  // the mapping positionally here. This is the same positional correspondence
  // that `applyEditorCncMetadata` already relies on.
  for (const artObject of artObjects) {
    const elementIds = Object.keys(artObject.elementAssignments)
    // We don't have direct access to editor nodes from here; instead we lean on
    // the operation list below. Elements contributing to each operation share a
    // `cutOrderGroupId`, which carries a stable suffix we can decode.
    for (const elementId of elementIds) {
      const assignment = artObject.elementAssignments[elementId]
      if (!assignment) continue
      // `cutOrderGroupId` looks like "<artObjectId>::<editorGroupId>" OR just
      // "<artObjectId>" for leaves that sat directly at the root. We don't have
      // leaf nodeIds from the bridge side, so this map stays coarse — the job
      // matcher below falls back on cutOrderIndex ranges.
      elementToNode.set(elementId, assignment.cutOrderGroupId ?? artObject.id)
    }
  }

  for (const operation of operations) {
    const set = new Set<string>()
    for (const elementId of operation.assigned_element_ids) {
      const nodeMarker = elementToNode.get(elementId)
      if (nodeMarker) set.add(nodeMarker)
    }
    nodeIdsByOperationId.set(operation.id, set)
  }

  // For each computed job, pick the operations whose any contributing
  // cutOrderGroupId overlaps the job's nodeIds. We compare markers, so this
  // only fires for jobs whose nodeIds show up as cutOrderGroupIds — root-level
  // single-node leaves and manual-override jobs built from the layer tree.
  const specs: JobSpec[] = []
  const assignedOperationIds = new Set<string>()
  for (const job of computedJobs) {
    const operationIdsForJob: string[] = []
    for (const operation of operations) {
      if (assignedOperationIds.has(operation.id)) continue
      const markers = nodeIdsByOperationId.get(operation.id) ?? new Set<string>()
      const matches = job.nodeIds.some((nodeId) =>
        Array.from(markers).some((marker) => marker.endsWith(`::${nodeId}`) || marker === nodeId),
      )
      if (matches) {
        operationIdsForJob.push(operation.id)
        assignedOperationIds.add(operation.id)
      }
    }
    if (operationIdsForJob.length === 0) {
      // One of the jobs has nothing to do — bail out rather than ship an empty
      // job header. The backward-compat single-anchor path is safer.
      return null
    }
    specs.push({
      id: job.id,
      name: job.name,
      operation_ids: operationIdsForJob,
      path_anchor: job.pathAnchor,
      cross_offset_from_artboard_bl: [
        job.crossOffsetFromArtboardBL.x,
        job.crossOffsetFromArtboardBL.y,
      ],
      is_big_spanner: job.isBigSpanner,
    })
  }

  // Every operation must end up in exactly one job — otherwise Rust would
  // silently drop cuts. When coverage isn't clean we bail back to single-job.
  if (assignedOperationIds.size !== operations.length) return null

  return specs
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

interface SvgTextForNode {
  svgText: string
  metadataRootNode: CanvasNode
  metadataNodesById: Record<string, CanvasNode>
  usesGeneratedCenterlineSvg: boolean
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
  // those need per-child export so each shape becomes a separate operation)
  if (isGroupNode(node) && node.originalSvg && !(node as GroupNode).generatorMetadata) {
    return {
      svgText: node.originalSvg,
      metadataRootNode: node,
      metadataNodesById: nodesById,
      usesGeneratedCenterlineSvg: false,
    }
  }

  // Fallback: export this single node as SVG
  // Create a minimal nodesById with just this subtree
  const subtreeIds = getSubtreeIds(nodeId, nodesById)
  const subtreeNodes: Record<string, CanvasNode> = {}
  for (const id of subtreeIds) {
    const subtreeNode = nodesById[id]
    if (subtreeNode) {
      subtreeNodes[id] = id === nodeId
        ? { ...subtreeNode, x: 0, y: 0 }
        : subtreeNode
    }
  }

  const metadataRootNode = subtreeNodes[nodeId]
  if (!metadataRootNode) return null

  return {
    svgText: exportToSVG(
      subtreeNodes,
      [nodeId],
      { ...artboard, x: 0, y: 0 },
      { forcePocketFill: true },
    ),
    metadataRootNode,
    metadataNodesById: subtreeNodes,
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

    // Check if there's a positional match from editor leaf metadata
    const leafMeta = leafMetadata[i]
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
