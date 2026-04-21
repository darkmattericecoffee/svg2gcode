import { afterEach, describe, expect, it } from 'vitest'

import { buildDepthPreviewPlan } from './booleanUnion'
import { buildLayerCncSummary, getLayerPreviewVisualProps } from './layerTreePresentation'
import { resolveNodePreviewEngraveMode, shouldUseToolDiameterStrokePreview } from './cncVisuals'
import { useEditorStore } from '../store'
import type { GroupNode, PathNode } from '../types/editor'

function makeGroupNode(overrides: Partial<GroupNode> = {}): GroupNode {
  return {
    id: 'root',
    type: 'group',
    name: 'Imported SVG',
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    draggable: true,
    locked: false,
    visible: true,
    opacity: 1,
    parentId: null,
    childIds: ['leaf'],
    ...overrides,
  }
}

function makePathNode(overrides: Partial<PathNode> = {}): PathNode {
  return {
    id: 'leaf',
    type: 'path',
    name: 'Leaf Path',
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    draggable: true,
    locked: false,
    visible: true,
    opacity: 1,
    parentId: 'root',
    data: 'M 0 0 L 10 0 L 10 10 L 0 10 Z',
    fill: undefined,
    stroke: '#111',
    strokeWidth: 1,
    ...overrides,
  }
}

const initialStoreState = useEditorStore.getState()

afterEach(() => {
  useEditorStore.setState(initialStoreState, true)
})

describe('preview engrave mode resolution', () => {
  it('keeps inherited pocket after deselect', () => {
    const root = makeGroupNode({
      cncMetadata: { cutDepth: 3, engraveType: 'pocket' },
    })
    const leaf = makePathNode()
    const nodesById = { root, leaf }

    useEditorStore.setState({
      ...useEditorStore.getState(),
      nodesById,
      rootIds: [root.id],
      selectedIds: [root.id],
      selectedStage: false,
    })

    expect(resolveNodePreviewEngraveMode(leaf, useEditorStore.getState().nodesById)).toBe('pocket')

    useEditorStore.getState().clearSelection()

    const stateAfterDeselect = useEditorStore.getState()
    expect(stateAfterDeselect.selectedIds).toEqual([])
    expect(stateAfterDeselect.nodesById.leaf?.cncMetadata).toBeUndefined()
    expect(resolveNodePreviewEngraveMode(
      stateAfterDeselect.nodesById.leaf as PathNode,
      stateAfterDeselect.nodesById,
    )).toBe('pocket')
  })

  it('prefers an explicit leaf contour over inherited pocket', () => {
    const root = makeGroupNode({
      cncMetadata: { cutDepth: 3, engraveType: 'pocket' },
    })
    const leaf = makePathNode({
      cncMetadata: { engraveType: 'contour' },
    })
    const nodesById = { root, leaf }

    expect(resolveNodePreviewEngraveMode(leaf, nodesById)).toBe('contour')
  })

  it('keeps geometrically open paths as contour under inherited pocket', () => {
    const root = makeGroupNode({
      cncMetadata: { cutDepth: 3, engraveType: 'pocket' },
    })
    const leaf = makePathNode({
      data: 'M 0 0 L 10 0 L 10 10',
    })
    const nodesById = { root, leaf }

    expect(resolveNodePreviewEngraveMode(leaf, nodesById)).toBe('contour')
  })

  it('uses tool-diameter contour preview for closed filled paths when explicitly set to contour', () => {
    const leaf = makePathNode({
      parentId: null,
      fill: '#f5d552',
      stroke: undefined,
      cncMetadata: { cutDepth: 3, engraveType: 'contour' },
    })
    const nodesById = { leaf }

    const resolvedMode = resolveNodePreviewEngraveMode(leaf, nodesById)

    expect(resolvedMode).toBe('contour')
    expect(shouldUseToolDiameterStrokePreview(leaf, resolvedMode)).toBe(true)
  })
})

describe('depth preview plan', () => {
  it('treats inherited pocket closed stroke-only paths as pocket area output', () => {
    const root = makeGroupNode({
      cncMetadata: { cutDepth: 3, engraveType: 'pocket' },
    })
    const leaf = makePathNode()
    const nodesById = { root, leaf }

    const plan = buildDepthPreviewPlan([root.id], nodesById, 3, 2)

    expect(plan.strokeShapes).toHaveLength(0)
    expect(plan.layers).toHaveLength(1)
    expect(plan.layers[0]).toMatchObject({
      depth: 3,
      mode: 'pocket',
      sourceNodeIds: [leaf.id],
    })
    expect(plan.layers[0]?.pathData).toBeTruthy()
  })
})

describe('layer tree presentation helpers', () => {
  it('matches inherited pocket summary and preview paint for stroke-only closed paths', () => {
    const root = makeGroupNode({
      cncMetadata: { cutDepth: 3, engraveType: 'pocket' },
    })
    const leaf = makePathNode()
    const nodesById = { root, leaf }

    const summary = buildLayerCncSummary(root, nodesById, 3)
    const preview = getLayerPreviewVisualProps(leaf, root.cncMetadata)

    expect(summary.mode).toBe('pocket')
    expect(preview.fill).not.toBe('none')
    expect(preview.strokeWidth).toBe(1.5)
  })
})
