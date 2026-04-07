import type { CanvasNode, CncMetadata } from '../types/editor'

export function mergeCncMetadata(
  cncMetadata?: CncMetadata,
  parentCncMetadata?: CncMetadata,
): CncMetadata | undefined {
  const cutDepth = cncMetadata?.cutDepth ?? parentCncMetadata?.cutDepth
  const engraveType = cncMetadata?.engraveType ?? parentCncMetadata?.engraveType

  if (cutDepth === undefined && engraveType === undefined) {
    return undefined
  }

  return { cutDepth, engraveType }
}

export function resolveNodeCncMetadata(
  node: CanvasNode,
  nodesById: Record<string, CanvasNode>,
): CncMetadata {
  let effectiveMetadata = node.cncMetadata
  let parentId = node.parentId

  while (parentId) {
    const parent = nodesById[parentId]
    effectiveMetadata = mergeCncMetadata(effectiveMetadata, parent?.cncMetadata)
    parentId = parent?.parentId ?? null
  }

  return effectiveMetadata ?? {}
}
