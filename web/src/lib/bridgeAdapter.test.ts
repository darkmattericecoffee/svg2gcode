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

  it('falls back to single-job output when explicit job coverage is incomplete', () => {
    const jobs = [
      computedJob('job-a', ['a'], 10, 20),
      computedJob('job-b', ['b'], 30, 40),
    ]
    const operations = [operation('op-a', 'job-a'), operation('op-b')]

    expect(jobSpecsFromComputedJobs(jobs, operations, [])).toBeNull()
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
})
