import type { CanvasNode, CncMetadata, GroupNode } from '../types/editor'
import type { NormalizedEngraveType } from './cncVisuals'
import { getCncVisualOverrides, resolveNodePreviewEngraveMode } from './cncVisuals'
import { mergeCncMetadata, resolveNodeCncMetadata } from './cncMetadata'

const DEPTH_EPSILON = 0.0001

const ENGRAVE_LABEL: Record<NormalizedEngraveType, string> = {
  contour: 'Contour',
  pocket: 'Pocket',
  plunge: 'Plunge',
}

export interface LayerCncSummary {
  depth: number | null
  depthLabel: string
  mode: NormalizedEngraveType | 'mixed'
  modeLabel: string
}

function collectLeafNodes(
  node: CanvasNode,
  nodesById: Record<string, CanvasNode>,
): CanvasNode[] {
  if (node.type !== 'group') return [node]

  const childNodes = (node as GroupNode).childIds.flatMap((childId) => {
    const child = nodesById[childId]
    return child ? collectLeafNodes(child, nodesById) : []
  })

  return childNodes.length > 0 ? childNodes : [node]
}

function formatDepth(depth: number): string {
  return `${Number(depth.toFixed(2))} mm`
}

export function buildLayerCncSummary(
  node: CanvasNode,
  nodesById: Record<string, CanvasNode>,
  defaultDepth: number,
): LayerCncSummary {
  const leafNodes = collectLeafNodes(node, nodesById)
  const depths = new Set<string>()
  const modes = new Set<NormalizedEngraveType>()
  let firstDepth: number | null = null
  let firstMode: NormalizedEngraveType | null = null

  leafNodes.forEach((leaf) => {
    const metadata = resolveNodeCncMetadata(leaf, nodesById)
    const depth = metadata.cutDepth ?? defaultDepth
    const mode = resolveNodePreviewEngraveMode(leaf, nodesById)

    if (firstDepth === null) firstDepth = depth
    if (firstMode === null) firstMode = mode

    depths.add((Math.round(depth / DEPTH_EPSILON) * DEPTH_EPSILON).toFixed(4))
    modes.add(mode)
  })

  const mixedDepth = depths.size > 1
  const mixedMode = modes.size > 1
  const mode: NormalizedEngraveType | 'mixed' = mixedMode ? 'mixed' : (firstMode ?? 'pocket')

  return {
    depth: mixedDepth ? null : firstDepth ?? defaultDepth,
    depthLabel: mixedDepth ? 'Mixed depth' : formatDepth(firstDepth ?? defaultDepth),
    mode,
    modeLabel: mode === 'mixed' ? 'Mixed' : ENGRAVE_LABEL[mode],
  }
}

function paintOrUndefined(value?: string): string | undefined {
  const normalized = value?.trim()
  if (!normalized || normalized === 'none') return undefined
  return normalized
}

function getBaseLayerPreviewVisualProps(
  node: Exclude<CanvasNode, GroupNode>,
): {
  fill: string
  stroke: string
  strokeWidth: number
} {
  const fill = paintOrUndefined('fill' in node ? node.fill : undefined)
  const stroke = paintOrUndefined('stroke' in node ? node.stroke : undefined)
  const strokeWidth = 'strokeWidth' in node ? node.strokeWidth : 1
  const fallbackStroke = fill ? 'none' : 'currentColor'

  return {
    fill: fill ?? 'none',
    stroke: stroke ?? fallbackStroke,
    strokeWidth: Boolean(stroke) || !fill ? Math.max(strokeWidth || 1, 1) : 0,
  }
}

export function getLayerPreviewVisualProps(
  node: Exclude<CanvasNode, GroupNode>,
  parentCncMetadata?: CncMetadata,
): {
  fill: string
  stroke: string
  strokeWidth: number
} {
  const base = getBaseLayerPreviewVisualProps(node)
  const cncOverrides = getCncVisualOverrides(node, node.cncMetadata, parentCncMetadata)

  return {
    fill: cncOverrides.fill ?? base.fill,
    stroke: cncOverrides.stroke ?? base.stroke,
    strokeWidth: cncOverrides.strokeWidth ?? base.strokeWidth,
  }
}

export function getChildLayerPreviewMetadata(
  node: CanvasNode,
  parentCncMetadata?: CncMetadata,
): CncMetadata | undefined {
  return mergeCncMetadata(node.cncMetadata, parentCncMetadata)
}
