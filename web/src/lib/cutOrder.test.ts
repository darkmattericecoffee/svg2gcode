import { describe, expect, it } from 'vitest'

import type { ArtboardState, CanvasNode, GroupNode, RectNode } from '../types/editor'
import { computeCutOrder } from './cutOrder'

const ARTBOARD: ArtboardState = { width: 600, height: 500, thickness: 18, x: 0, y: 0 }

function rect(
  id: string,
  x: number,
  y: number,
  w = 10,
  h = 10,
  parentId: string | null = null,
): RectNode {
  return {
    id,
    type: 'rect',
    name: id,
    x,
    y,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    draggable: true,
    locked: false,
    visible: true,
    opacity: 1,
    parentId,
    width: w,
    height: h,
    fill: '',
    stroke: '',
    strokeWidth: 0,
  }
}

function group(id: string, childIds: string[], parentId: string | null = null): GroupNode {
  return {
    id,
    type: 'group',
    name: id,
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    draggable: true,
    locked: false,
    visible: true,
    opacity: 1,
    parentId,
    childIds,
  }
}

function scene(nodes: CanvasNode[]): Record<string, CanvasNode> {
  return Object.fromEntries(nodes.map((n) => [n.id, n]))
}

describe('computeCutOrder — magic auto planner', () => {
  it('keeps separate SVG groups apart even when their leaf bounds touch', () => {
    // Two separate groups, each holding shapes that sit right next to each other.
    const nodes: CanvasNode[] = [
      group('g1', ['a', 'b']),
      group('g2', ['c', 'd']),
      rect('a', 100, 100, 20, 20, 'g1'),
      rect('b', 125, 100, 20, 20, 'g1'),
      rect('c', 150, 100, 20, 20, 'g2'),
      rect('d', 175, 100, 20, 20, 'g2'),
    ]
    const result = computeCutOrder(['g1', 'g2'], scene(nodes), 'auto', null, ARTBOARD)
    expect(result.groupOrder).toHaveLength(2)
    const g1BlobIds = result.sequence.filter((l) => l.nodeId === 'a' || l.nodeId === 'b').map((l) => l.groupId)
    const g2BlobIds = result.sequence.filter((l) => l.nodeId === 'c' || l.nodeId === 'd').map((l) => l.groupId)
    expect(new Set(g1BlobIds)).toHaveLength(1)
    expect(new Set(g2BlobIds)).toHaveLength(1)
    expect(g1BlobIds[0]).not.toBe(g2BlobIds[0])
  })

  it('keeps separate SVG groups apart when only their broad group bounds overlap', () => {
    const nodes: CanvasNode[] = [
      group('g1', ['a', 'b']),
      group('g2', ['c', 'd']),
      rect('a', 20, 20, 20, 20, 'g1'),
      rect('b', 220, 220, 20, 20, 'g1'),
      rect('c', 120, 120, 20, 20, 'g2'),
      rect('d', 145, 120, 20, 20, 'g2'),
    ]
    const result = computeCutOrder(['g1', 'g2'], scene(nodes), 'auto', null, ARTBOARD)
    expect(result.groupOrder).toHaveLength(2)
    const g1BlobIds = result.sequence.filter((l) => l.nodeId === 'a' || l.nodeId === 'b').map((l) => l.groupId)
    const g2BlobIds = result.sequence.filter((l) => l.nodeId === 'c' || l.nodeId === 'd').map((l) => l.groupId)
    expect(new Set(g1BlobIds)).toHaveLength(1)
    expect(new Set(g2BlobIds)).toHaveLength(1)
    expect(g1BlobIds[0]).not.toBe(g2BlobIds[0])
  })

  it('keeps a single SVG group in one blob even when its shapes are far apart', () => {
    // One group containing two clusters on opposite corners of the artboard.
    const nodes: CanvasNode[] = [
      group('g', ['a', 'b', 'c', 'd']),
      rect('a', 20, 20, 15, 15, 'g'),
      rect('b', 40, 20, 15, 15, 'g'),
      rect('c', 500, 400, 15, 15, 'g'),
      rect('d', 520, 400, 15, 15, 'g'),
    ]
    const result = computeCutOrder(['g'], scene(nodes), 'auto', null, ARTBOARD)
    expect(result.groupOrder).toHaveLength(1)
    const blobIds = result.sequence.map((l) => l.groupId)
    expect(new Set(blobIds)).toHaveLength(1)
    expect(result.sequence.map((l) => l.nodeId)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps grouped ring details together instead of splitting the containing contour', () => {
    const nodes: CanvasNode[] = [
      group('ring-group', ['ring', 'inner-a', 'inner-b']),
      rect('ring', 90, 90, 140, 120, 'ring-group'),
      rect('inner-a', 120, 120, 15, 15, 'ring-group'),
      rect('inner-b', 180, 160, 15, 15, 'ring-group'),
    ]
    const result = computeCutOrder(['ring-group'], scene(nodes), 'auto', null, ARTBOARD)
    expect(result.groupOrder).toHaveLength(1)
    expect(result.spannerNodeIds).toEqual([])
    expect(new Set(result.sequence.map((l) => l.groupId))).toHaveLength(1)
  })

  it('groups direct sibling dots while isolating a global outline from the same parent', () => {
    const nodes: CanvasNode[] = [
      group('import', ['text', 'outline', 'dot-a', 'dot-b', 'dot-c']),
      group('text', ['letter-a', 'letter-b'], 'import'),
      rect('letter-a', 250, 230, 12, 18, 'text'),
      rect('letter-b', 266, 230, 12, 18, 'text'),
      rect('outline', 10, 10, 560, 450, 'import'),
      rect('dot-a', 40, 430, 8, 8, 'import'),
      rect('dot-b', 280, 250, 8, 8, 'import'),
      rect('dot-c', 520, 40, 8, 8, 'import'),
    ]
    const result = computeCutOrder(['import'], scene(nodes), 'auto', null, ARTBOARD)
    expect(result.spannerNodeIds).toEqual(['outline'])
    expect(result.groupOrder).toHaveLength(3)
    const dotGroupIds = result.sequence
      .filter((l) => l.nodeId.startsWith('dot-'))
      .map((l) => l.groupId)
    expect(new Set(dotGroupIds)).toHaveLength(1)
    expect(result.sequence.at(-1)?.nodeId).toBe('outline')
  })

  it('isolates a rect that encompasses 3+ shapes and puts it last', () => {
    // Big outer rect (passe-partout) with four small rects inside it.
    const nodes: CanvasNode[] = [
      rect('frame', 50, 50, 400, 300),
      rect('inner1', 80, 80, 20, 20),
      rect('inner2', 150, 80, 20, 20),
      rect('inner3', 220, 80, 20, 20),
      rect('inner4', 290, 80, 20, 20),
    ]
    const result = computeCutOrder(
      ['frame', 'inner1', 'inner2', 'inner3', 'inner4'],
      scene(nodes),
      'auto',
      null,
      ARTBOARD,
    )
    expect(result.spannerNodeIds).toEqual(['frame'])
    // Frame is the last item in the sequence.
    expect(result.sequence[result.sequence.length - 1]!.nodeId).toBe('frame')
    // Frame is in its own blob.
    const frameBlob = result.sequence.find((l) => l.nodeId === 'frame')!.groupId
    const innerBlobs = result.sequence
      .filter((l) => l.nodeId !== 'frame')
      .map((l) => l.groupId)
    for (const blobId of innerBlobs) expect(blobId).not.toBe(frameBlob)
  })

  it('orders detail blobs by distance from the artboard bottom-left corner', () => {
    // Two clusters on opposite ends; near bottom-left should come first.
    const nodes: CanvasNode[] = [
      rect('far-a', 500, 50, 10, 10),
      rect('far-b', 520, 50, 10, 10),
      rect('near-a', 30, 470, 10, 10),
      rect('near-b', 50, 470, 10, 10),
    ]
    const result = computeCutOrder(
      ['far-a', 'far-b', 'near-a', 'near-b'],
      scene(nodes),
      'auto',
      null,
      ARTBOARD,
    )
    expect(result.sequence.slice(0, 2).map((l) => l.nodeId).sort()).toEqual(['near-a', 'near-b'])
    expect(result.sequence.slice(2).map((l) => l.nodeId).sort()).toEqual(['far-a', 'far-b'])
  })

  it('honors manual order and collapses all leaves into one root groupId', () => {
    const nodes: CanvasNode[] = [
      rect('a', 10, 10, 10, 10),
      rect('b', 50, 10, 10, 10),
      rect('c', 100, 10, 10, 10),
    ]
    const result = computeCutOrder(
      ['a', 'b', 'c'],
      scene(nodes),
      'manual',
      ['c', 'a', 'b'],
      ARTBOARD,
    )
    expect(result.sequence.map((l) => l.nodeId)).toEqual(['c', 'a', 'b'])
    expect(result.groupOrder).toEqual(['__root__'])
    expect(result.spannerNodeIds).toEqual([])
  })

  it('skips invisible nodes entirely', () => {
    const hidden = rect('a', 10, 10, 10, 10)
    hidden.visible = false
    const nodes: CanvasNode[] = [hidden, rect('b', 50, 10, 10, 10)]
    const result = computeCutOrder(['a', 'b'], scene(nodes), 'auto', null, ARTBOARD)
    expect(result.sequence.map((l) => l.nodeId)).toEqual(['b'])
  })

  it('orders multiple spanners smallest → largest', () => {
    // Two encompassing rects plus enough small shapes to trigger contain-count detection.
    const nodes: CanvasNode[] = [
      rect('big', 20, 20, 550, 450),
      rect('medium', 40, 40, 300, 250),
      rect('s1', 60, 60, 10, 10),
      rect('s2', 100, 60, 10, 10),
      rect('s3', 140, 60, 10, 10),
      rect('s4', 180, 60, 10, 10),
    ]
    const result = computeCutOrder(
      ['big', 'medium', 's1', 's2', 's3', 's4'],
      scene(nodes),
      'auto',
      null,
      ARTBOARD,
    )
    expect(result.spannerNodeIds).toEqual(expect.arrayContaining(['big', 'medium']))
    const seq = result.sequence.map((l) => l.nodeId)
    const mediumIdx = seq.indexOf('medium')
    const bigIdx = seq.indexOf('big')
    expect(mediumIdx).toBeLessThan(bigIdx)
    // Both spanners come after every detail leaf.
    for (const id of ['s1', 's2', 's3', 's4']) {
      expect(seq.indexOf(id)).toBeLessThan(mediumIdx)
    }
  })
})
