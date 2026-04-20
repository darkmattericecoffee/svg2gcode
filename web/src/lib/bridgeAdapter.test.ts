import { describe, expect, it } from 'vitest'
import { parseGcodeProgram, type JobSpan } from '@svg2gcode/bridge/viewer'
import type { FrontendOperation } from '@svg2gcode/bridge'

import type { ComputedJob } from './jobs'
import { jobSpecsFromComputedJobs } from './bridgeAdapter'

function computedJob(id: string, nodeIds: string[], x: number, y: number): ComputedJob {
  return {
    id,
    name: id,
    nodeIds,
    pathAnchor: 'Center',
    forceOwnJob: false,
    boundsMm: { minX: x - 5, minY: y - 5, maxX: x + 5, maxY: y + 5 },
    anchorPointMm: { x, y },
    crossOffsetFromArtboardBL: { x, y },
    isBigSpanner: false,
    fromManualOverride: true,
  }
}

function operation(id: string, jobId?: string): FrontendOperation {
  return {
    id,
    name: id,
    target_depth_mm: 3,
    assigned_element_ids: [`el-${id}`],
    color: null,
    engrave_type: 'outline',
    fill_mode: null,
    jobId,
  }
}

describe('jobSpecsFromComputedJobs', () => {
  it('uses explicit operation job ids instead of inferring from SVG group names', () => {
    const jobs = [
      computedJob('job-a', ['a'], 10, 20),
      computedJob('job-b', ['b'], 30, 40),
    ]
    const operations = [operation('op-a', 'job-a'), operation('op-b', 'job-b')]

    const specs = jobSpecsFromComputedJobs(jobs, operations, [])

    expect(specs?.map((job) => job.operation_ids)).toEqual([['op-a'], ['op-b']])
    expect(specs?.map((job) => job.cross_offset_from_artboard_bl)).toEqual([[10, 20], [30, 40]])
  })

  it('emits a single JobSpec when the plan is one job', () => {
    const jobs = [computedJob('job-solo', ['a', 'b'], 11, 22)]
    const operations = [operation('op-a', 'job-solo'), operation('op-b', 'job-solo')]

    const specs = jobSpecsFromComputedJobs(jobs, operations, [])

    expect(specs).toHaveLength(1)
    expect(specs?.[0]?.id).toBe('job-solo')
    expect(specs?.[0]?.operation_ids).toEqual(['op-a', 'op-b'])
    expect(specs?.[0]?.cross_offset_from_artboard_bl).toEqual([11, 22])
  })

  it('recovers an orphan operation by matching assigned_element_ids to a jobs node', () => {
    const jobs = [
      computedJob('job-a', ['a'], 10, 20),
      computedJob('job-b', ['b'], 30, 40),
    ]
    // op-b carries no jobId but its composite element ids start with `b::...`,
    // so we can recover and place it into job-b.
    const orphan: FrontendOperation = {
      id: 'op-b',
      name: 'op-b',
      target_depth_mm: 3,
      assigned_element_ids: ['b::__root__'],
      color: null,
      engrave_type: 'outline',
      fill_mode: null,
    }
    const operations = [operation('op-a', 'job-a'), orphan]

    const specs = jobSpecsFromComputedJobs(jobs, operations, [])

    expect(specs?.map((job) => job.operation_ids)).toEqual([['op-a'], ['op-b']])
  })

  it('falls back to the first job when no recovery path matches', () => {
    const jobs = [computedJob('job-a', ['a'], 10, 20)]
    const operations = [operation('op-a', 'job-a'), operation('op-orphan', 'job-missing')]

    const specs = jobSpecsFromComputedJobs(jobs, operations, [])
    expect(specs?.[0]?.operation_ids).toEqual(['op-a', 'op-orphan'])
  })
})

describe('parseGcodeProgram operation cut-order', () => {
  it('sorts operation spans by cut-order index parsed from the marker', () => {
    const gcode = [
      '; === JOB 1/1: Only ===',
      '; JOB_ID: job-solo',
      '; JOB_NAME: Only',
      '; JOB_ANCHOR: Center',
      '; JOB_CROSS_OFFSET_FROM_ARTBOARD_BL: X 0, Y 0',
      '; JOB_PREVIEW_OFFSET: X 0, Y 0',
      '; JOB_BIG_SPANNER: false',
      ';operation:start:op-second:5:5mm · Outline',
      'G0 X0 Y0',
      'G1 X1 Y0',
      ';operation:end:op-second',
      ';operation:start:op-first:1:1mm · Outline',
      'G0 X2 Y0',
      'G1 X3 Y0',
      ';operation:end:op-first',
    ].join('\n')

    const parsed = parseGcodeProgram(gcode, [
      { operation_id: 'op-second', operation_name: '5mm · Outline', color: null, start_line: 10, end_line: 11, cut_order_index: 5 },
      { operation_id: 'op-first', operation_name: '1mm · Outline', color: null, start_line: 14, end_line: 15, cut_order_index: 1 },
    ])

    expect(parsed.operationSpans.map((span) => span.operationId)).toEqual(['op-first', 'op-second'])
    expect(parsed.operationSpans.map((span) => span.cutOrderIndex)).toEqual([1, 5])
  })
})

describe('parseGcodeProgram multi-job preview offsets', () => {
  it('rebases each job from its own JOB_PREVIEW_OFFSET', () => {
    const gcode = [
      '; === JOB 1/2: First ===',
      '; JOB_ID: job-a',
      '; JOB_NAME: First',
      '; JOB_BOUNDS: X -1 1, Y -1 1',
      '; JOB_ANCHOR: Center',
      '; JOB_CROSS_OFFSET_FROM_ARTBOARD_BL: X 10, Y 20',
      '; JOB_PREVIEW_OFFSET: X 10, Y 20',
      '; JOB_BIG_SPANNER: false',
      'G0 X0 Y0',
      'G1 X1 Y0',
      '; JOB_STOP: realign router before next job',
      'M0',
      '; === JOB 2/2: Second ===',
      '; JOB_ID: job-b',
      '; JOB_NAME: Second',
      '; JOB_BOUNDS: X -2 2, Y -2 2',
      '; JOB_ANCHOR: Center',
      '; JOB_CROSS_OFFSET_FROM_ARTBOARD_BL: X 100, Y 200',
      '; JOB_PREVIEW_OFFSET: X 100, Y 200',
      '; JOB_BIG_SPANNER: false',
      'G0 X0 Y0',
      'G1 X2 Y0',
    ].join('\n')

    const parsed = parseGcodeProgram(gcode, [])
    const jobs = parsed.jobs as JobSpan[]

    expect(jobs.map((job) => job.previewOffset)).toEqual([{ x: 10, y: 20 }, { x: 100, y: 200 }])
    expect(parsed.events.find((event) => event.kind === 'job_stop')?.nextJobId).toBe('job-b')
    expect(parsed.segments.map((segment) => segment.jobId)).toEqual(['job-a', 'job-b'])
    expect(parsed.segments[1]?.start).toMatchObject({ x: 100, y: 200 })
  })

  it('keeps jobs usable when JOB_PREVIEW_OFFSET is missing', () => {
    const gcode = [
      '; === JOB 1/2: First ===',
      '; JOB_ID: job-a',
      '; JOB_NAME: First',
      '; JOB_CROSS_OFFSET_FROM_ARTBOARD_BL: X 50, Y 60',
      '; JOB_BIG_SPANNER: false',
      'G0 X0 Y0',
      'G1 X2 Y0',
      '; JOB_STOP: realign router before next job',
      'M0',
      '; === JOB 2/2: Second ===',
      '; JOB_ID: job-b',
      '; JOB_NAME: Second',
      '; JOB_CROSS_OFFSET_FROM_ARTBOARD_BL: X 150, Y 160',
      '; JOB_BIG_SPANNER: false',
      'G0 X0 Y0',
      'G1 X3 Y0',
    ].join('\n')

    const parsed = parseGcodeProgram(gcode, [])
    const jobs = parsed.jobs as JobSpan[]

    expect(jobs.map((job) => job.previewOffset)).toEqual([{ x: 50, y: 60 }, { x: 150, y: 160 }])
    expect(jobs[0]?.bounds).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 0 })
    expect(jobs[1]?.bounds).toEqual({ minX: 0, minY: 0, maxX: 3, maxY: 0 })
    expect(parsed.segments.map((segment) => segment.jobId)).toEqual(['job-a', 'job-b'])
    expect(parsed.segments[0]?.start).toMatchObject({ x: 50, y: 60 })
    expect(parsed.segments[1]?.start).toMatchObject({ x: 150, y: 160 })
  })

  it('parses job metadata from parenthesized gcode comments too', () => {
    const gcode = [
      '( === JOB 1/1: Parenthesized === )',
      '( JOB_ID: job-parenthesized )',
      '( JOB_NAME: Parenthesized )',
      '( JOB_BOUNDS: X -1 1, Y -2 2 )',
      '( JOB_CROSS_OFFSET_FROM_ARTBOARD_BL: X 70, Y 80 )',
      '( JOB_PREVIEW_OFFSET: X 71, Y 81 )',
      '( JOB_BIG_SPANNER: false )',
      'G0 X0 Y0',
      'G1 X1 Y0',
    ].join('\n')

    const parsed = parseGcodeProgram(gcode, [])

    expect(parsed.jobs).toHaveLength(1)
    expect(parsed.jobs[0]).toMatchObject({
      jobId: 'job-parenthesized',
      previewOffset: { x: 71, y: 81 },
      crossOffsetFromArtboardBL: { x: 70, y: 80 },
      bounds: { minX: -1, minY: -2, maxX: 1, maxY: 2 },
    })
    expect(parsed.segments[0]?.jobId).toBe('job-parenthesized')
  })
})
