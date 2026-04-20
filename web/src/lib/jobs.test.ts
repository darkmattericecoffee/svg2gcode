import { describe, expect, it } from 'vitest'

import type { ArtboardState, CanvasNode, GroupNode, Job, MachiningSettings, RectNode } from '../types/editor'
import type { CutOrderResult } from './cutOrder'
import {
  assignLeafIdsToJob,
  computeJobs,
  manualJobsFromComputed,
  moveLeafToJob,
  normalizeManualJobs,
  splitManualJobsAtCutIndex,
} from './jobs'

const ARTBOARD: ArtboardState = { width: 600, height: 500, thickness: 18, x: 0, y: 0 }

const BASE_SETTINGS: MachiningSettings = {
  toolDiameter: 3,
  toolShape: 'Flat',
  defaultDepthMm: 3,
  passCount: 1,
  maxStepdown: null,
  stepover: null,
  maxFillPasses: null,
  cutFeedrate: null,
  shallowCutFeedrate: null,
  plungeFeedrate: null,
  travelZ: null,
  cutZ: null,
  machineWidth: null,
  machineHeight: null,
  tabsEnabled: false,
  tabWidth: 4,
  tabHeight: 1.5,
  tabSpacing: 50,
  optimizePathOrder: true,
  pathAnchor: 'Center',
  clusterDetourRadius: null,
  circularInterpolation: true,
  cutOrderStrategy: 'svg',
  manualCutOrder: null,
  jobsEnabled: true,
  jobClusterRadius: 60,
  manualJobs: null,
}

function rect(id: string, x: number, y: number, w = 10, h = 10, parentId: string | null = null): RectNode {
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
    stroke: '#000',
    strokeWidth: 1,
  }
}

function group(id: string, childIds: string[]): GroupNode {
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
    parentId: null,
    childIds,
  }
}

function cutOrderFromIds(ids: string[]): CutOrderResult {
  return {
    sequence: ids.map((nodeId, index) => ({
      nodeId,
      groupId: '__root__',
      groupName: 'Root',
      index,
    })),
    groupOrder: ['__root__'],
    groupNames: { __root__: 'Root' },
  }
}

function makeScene(nodes: CanvasNode[]): Record<string, CanvasNode> {
  return Object.fromEntries(nodes.map((n) => [n.id, n]))
}

describe('computeJobs', () => {
  it('keeps auto job ids stable across recomputes', () => {
    const childIds = ['a', 'b', 'c']
    const nodes: CanvasNode[] = [
      group('import', childIds),
      rect('a', 100, 100, 20, 20, 'import'),
      rect('b', 130, 100, 20, 20, 'import'),
      rect('c', 100, 130, 20, 20, 'import'),
    ]
    const scene = makeScene(nodes)
    const cutOrder = cutOrderFromIds(childIds)

    const first = computeJobs(cutOrder, scene, BASE_SETTINGS, ARTBOARD).jobs
    const second = computeJobs(cutOrder, scene, BASE_SETTINGS, ARTBOARD).jobs

    expect(first.map((job) => job.id)).toEqual(second.map((job) => job.id))
    expect(first).toHaveLength(1)
  })

  it('splits a manual job before the marker row and carries later leaves forward', () => {
    const cutOrder = cutOrderFromIds(['a', 'b', 'c', 'd'])
    const base = manualJobsFromComputed([
      {
        id: 'job-all',
        name: 'Job 1',
        nodeIds: ['a', 'b', 'c', 'd'],
        pathAnchor: 'Center',
        forceOwnJob: false,
        boundsMm: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
        anchorPointMm: { x: 5, y: 5 },
        crossOffsetFromArtboardBL: { x: 5, y: 495 },
        isBigSpanner: false,
        fromManualOverride: false,
      },
    ])

    const split = splitManualJobsAtCutIndex(cutOrder, base, 2)
    expect(split.map((job) => job.nodeIds)).toEqual([['a', 'b'], ['c', 'd']])

    const withInsertedLeaf = normalizeManualJobs(cutOrderFromIds(['a', 'b', 'c', 'x', 'd']), split)
    expect(withInsertedLeaf.map((job) => job.nodeIds)).toEqual([['a', 'b'], ['c', 'x', 'd']])
  })

  it('normalizes deleted and duplicate leaves without losing the visible order', () => {
    const cutOrder = cutOrderFromIds(['a', 'b', 'c'])
    const normalized = normalizeManualJobs(cutOrder, [
      { id: 'one', name: 'Job 1', nodeIds: ['a', 'b', 'b', 'missing'], pathAnchor: 'Center', forceOwnJob: false },
      { id: 'two', name: 'Job 2', nodeIds: ['b', 'c'], pathAnchor: 'Center', forceOwnJob: false },
    ])

    expect(normalized.map((job) => job.nodeIds)).toEqual([['a', 'b'], ['c']])
  })

  it('moves selected cut-order leaves into an existing job', () => {
    const cutOrder = cutOrderFromIds(['a', 'b', 'c', 'd'])
    const base: Job[] = [
      { id: 'one', name: 'Job 1', nodeIds: ['a', 'b'], pathAnchor: 'Center', forceOwnJob: false },
      { id: 'two', name: 'Job 2', nodeIds: ['c', 'd'], pathAnchor: 'Center', forceOwnJob: false },
    ]

    const next = assignLeafIdsToJob(cutOrder, base, ['b', 'c'], 'one')
    expect(next.map((job) => job.nodeIds)).toEqual([['a', 'b', 'c'], ['d']])
  })

  it('moves a dragged leaf into another job and updates manual cut order', () => {
    const cutOrder = cutOrderFromIds(['a', 'b', 'c', 'd'])
    const base: Job[] = [
      { id: 'one', name: 'Job 1', nodeIds: ['a', 'b'], pathAnchor: 'Center', forceOwnJob: false },
      { id: 'two', name: 'Job 2', nodeIds: ['c', 'd'], pathAnchor: 'Center', forceOwnJob: false },
    ]

    const result = moveLeafToJob(cutOrder, base, 'b', 'two', 'd', true)

    expect(result.manualCutOrder).toEqual(['a', 'c', 'b', 'd'])
    expect(result.manualJobs.map((job) => job.nodeIds)).toEqual([['a'], ['c', 'b', 'd']])
  })
})
