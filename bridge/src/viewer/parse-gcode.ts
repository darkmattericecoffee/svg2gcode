import { clamp } from "../utils";
import type { OperationLineRange } from "../types";

export type MotionKind = "rapid" | "plunge" | "cut" | "retract";

export type PathAnchor =
  | "TopLeft"
  | "TopCenter"
  | "TopRight"
  | "MiddleLeft"
  | "Center"
  | "MiddleRight"
  | "BottomLeft"
  | "BottomCenter"
  | "BottomRight";

export interface ParsedSegment {
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
  command: "G0" | "G1";
  motionKind: MotionKind;
  lineNumber: number;
  operationId: string | null;
  operationName: string | null;
  operationColor: string | null;
  feedrate: number | null;
  distance: number;
  cumulativeDistanceStart: number;
  cumulativeDistanceEnd: number;
  /** Job that contains this segment (null for single-job / legacy output). */
  jobId: string | null;
}

export interface ParsedEvent {
  /** `job_stop` fires at M0 between jobs — playback should pause here and
   *  surface the realign prompt using `position`/`nextJobId`. */
  kind: "plunge" | "retract" | "job_stop";
  lineNumber: number;
  distance: number;
  operationId: string | null;
  operationName: string | null;
  position: { x: number; y: number; z: number };
  /** Only set for `job_stop` — id of the job the machine is about to enter. */
  nextJobId?: string | null;
}

/** One job's span in a multi-job program. `previewOffset` is the
 *  job-local-to-world translation baked into each job's gcode body so the
 *  3D preview can place it back on the stock. */
export interface JobSpan {
  jobId: string;
  jobName: string;
  /** 1-based position of the job in the program. */
  jobIndex: number;
  jobTotal: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  anchor: PathAnchor;
  crossOffsetFromArtboardBL: { x: number; y: number };
  previewOffset: { x: number; y: number };
  startLine: number;
  endLine: number;
  isBigSpanner: boolean;
}

export interface OperationSpan {
  operationId: string;
  operationName: string;
  color: string | null;
  startDistance: number;
  endDistance: number;
  /** Cut-order index as stamped into the `;operation:start:` marker by the
   *  emitter. `null` when the marker is in the legacy two-field form or when
   *  the frontend had no cut-order data for this operation. Spans are sorted
   *  by this value (ascending) so the preview honours the frontend order. */
  cutOrderIndex: number | null;
}

export interface ParsedProgram {
  segments: ParsedSegment[];
  bounds: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  } | null;
  totalDistance: number;
  events: ParsedEvent[];
  operationSpans: OperationSpan[];
  /** Whole-program preview offset. For multi-job programs, this mirrors the
   *  first job's offset so existing single-offset consumers degrade cleanly;
   *  per-job offsets live on `jobs[n].previewOffset`. */
  previewOffset: { x: number; y: number };
  /** Empty for legacy / single-job output. */
  jobs: JobSpan[];
}

export interface PlaybackSample {
  distance: number;
  segmentIndex: number;
  segment: ParsedSegment | null;
  position: { x: number; y: number; z: number };
  motionKind: MotionKind;
  operationId: string | null;
}

export function parseGcodeProgram(
  gcode: string,
  operationRanges: OperationLineRange[],
): ParsedProgram {
  const operationForLine = buildOperationLineMap(operationRanges);
  const lines = gcode.split(/\r?\n/);
  const jobs = parseJobSpans(lines);
  // Fill in job end lines now that we know the total line count.
  for (let i = 0; i < jobs.length; i += 1) {
    const nextStart = jobs[i + 1]?.startLine ?? lines.length + 1;
    jobs[i].endLine = nextStart - 1;
  }
  const legacyPreviewOffset = parsePreviewOffset(gcode);
  // Per-job programs have no top-level PREVIEW_OFFSET; fall back to the
  // first job's offset so single-offset consumers still see something sane.
  const previewOffset =
    jobs.length > 0 ? jobs[0].previewOffset : legacyPreviewOffset;

  const jobForLine = (lineNumber: number): JobSpan | null => {
    if (jobs.length === 0) return null;
    // Linear scan is fine — N jobs is small.
    for (const job of jobs) {
      if (lineNumber >= job.startLine && lineNumber <= job.endLine) {
        return job;
      }
    }
    return null;
  };

  let modalCommand: "G0" | "G1" | "G2" | "G3" = "G0";
  let modalFeedrate: number | null = null;
  let currentJob: JobSpan | null = null;
  let currentOffset = previewOffset;
  let current = { x: currentOffset.x, y: currentOffset.y, z: 0 };
  let totalDistance = 0;
  const segments: ParsedSegment[] = [];
  const events: ParsedEvent[] = [];
  let bounds: ParsedProgram["bounds"] = null;

  const pushSegment = (
    start: { x: number; y: number; z: number },
    end: { x: number; y: number; z: number },
    command: "G0" | "G1",
    lineNumber: number,
    feedrate: number | null,
  ): { distance: number } => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance <= 1.0e-9) {
      return { distance: 0 };
    }

    const operation = operationForLine.get(lineNumber) ?? null;
    const motionKind = classifyMotion(command, start, end);
    const segment: ParsedSegment = {
      start,
      end,
      command,
      motionKind,
      lineNumber,
      operationId: operation?.operation_id ?? null,
      operationName: operation?.operation_name ?? null,
      operationColor: operation?.color ?? null,
      feedrate,
      distance,
      cumulativeDistanceStart: totalDistance,
      cumulativeDistanceEnd: totalDistance + distance,
      jobId: currentJob?.jobId ?? null,
    };
    totalDistance += distance;
    segments.push(segment);

    if (motionKind === "plunge" || motionKind === "retract") {
      events.push({
        kind: motionKind,
        lineNumber,
        distance: segment.cumulativeDistanceEnd,
        operationId: segment.operationId,
        operationName: segment.operationName,
        position: end,
      });
    }

    bounds = bounds
      ? {
          minX: Math.min(bounds.minX, segment.start.x, segment.end.x),
          minY: Math.min(bounds.minY, segment.start.y, segment.end.y),
          minZ: Math.min(bounds.minZ, segment.start.z, segment.end.z),
          maxX: Math.max(bounds.maxX, segment.start.x, segment.end.x),
          maxY: Math.max(bounds.maxY, segment.start.y, segment.end.y),
          maxZ: Math.max(bounds.maxZ, segment.start.z, segment.end.z),
        }
      : {
          minX: Math.min(segment.start.x, segment.end.x),
          minY: Math.min(segment.start.y, segment.end.y),
          minZ: Math.min(segment.start.z, segment.end.z),
          maxX: Math.max(segment.start.x, segment.end.x),
          maxY: Math.max(segment.start.y, segment.end.y),
          maxZ: Math.max(segment.start.z, segment.end.z),
        };

    return { distance };
  };

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;

    // Handle job boundary transitions before parsing motion on this line.
    // Each job rebases its gcode around its own anchor, so the parser's
    // internal "current position" must snap to the new job's world-space
    // origin before the next move is resolved.
    const jobForThisLine = jobForLine(lineNumber);
    if (jobForThisLine !== currentJob) {
      currentJob = jobForThisLine;
      currentOffset = currentJob?.previewOffset ?? legacyPreviewOffset;
      // Reset modal position — a job starts with the spindle parked.
      current = { x: currentOffset.x, y: currentOffset.y, z: current.z };
    }

    const line = rawLine.split(";")[0].trim();
    if (!line) {
      continue;
    }

    // M0 between jobs — emit a `job_stop` event pointing at the upcoming
    // job so machine playback can surface the realign prompt.
    if (/^M0\b/i.test(line) || /^M00\b/i.test(line)) {
      const nextJob = jobs.find((j) => j.startLine > lineNumber) ?? null;
      events.push({
        kind: "job_stop",
        lineNumber,
        distance: totalDistance,
        operationId: null,
        operationName: null,
        position: { ...current },
        nextJobId: nextJob?.jobId ?? null,
      });
      continue;
    }

    const tokens = line.split(/\s+/);
    const next = { ...current };
    let hasMove = false;
    let arcR: number | null = null;
    let arcI: number | null = null;
    let arcJ: number | null = null;

    for (const token of tokens) {
      if (token === "G0" || token === "G00") {
        modalCommand = "G0";
      } else if (token === "G1" || token === "G01") {
        modalCommand = "G1";
      } else if (token === "G2" || token === "G02") {
        modalCommand = "G2";
      } else if (token === "G3" || token === "G03") {
        modalCommand = "G3";
      } else if (token.startsWith("X")) {
        next.x = Number.parseFloat(token.slice(1)) + currentOffset.x;
        hasMove = true;
      } else if (token.startsWith("Y")) {
        next.y = Number.parseFloat(token.slice(1)) + currentOffset.y;
        hasMove = true;
      } else if (token.startsWith("Z")) {
        next.z = Number.parseFloat(token.slice(1));
        hasMove = true;
      } else if (token.startsWith("F")) {
        modalFeedrate = Number.parseFloat(token.slice(1));
      } else if (token.startsWith("R")) {
        arcR = Number.parseFloat(token.slice(1));
      } else if (token.startsWith("I")) {
        arcI = Number.parseFloat(token.slice(1));
      } else if (token.startsWith("J")) {
        arcJ = Number.parseFloat(token.slice(1));
      }
    }

    if (!hasMove) {
      continue;
    }

    if (modalCommand === "G2" || modalCommand === "G3") {
      const clockwise = modalCommand === "G2";
      const arcPoints = expandArc(current, next, arcR, arcI, arcJ, clockwise);
      let segStart = current;
      for (const pt of arcPoints) {
        pushSegment(segStart, pt, "G1", lineNumber, modalFeedrate);
        segStart = pt;
      }
      current = next;
      continue;
    }

    const linearCommand: "G0" | "G1" = modalCommand === "G0" ? "G0" : "G1";
    pushSegment(current, next, linearCommand, lineNumber, modalFeedrate);
    current = next;
  }

  completeParsedJobs(jobs, segments);

  // The emitter writes operations in cut-order already, so file order and
  // cut-order agree for indexed spans. Sort explicitly so that consumers can
  // trust `operationSpans` to match the frontend's cutOrder.ts output even
  // if a future ingest path (hand-edited gcode, alternative emitters) feeds
  // us indices out of order. Legacy spans without an index keep their input
  // position via stable sort.
  const operationSpans = buildOperationSpans(segments, operationRanges);
  operationSpans.sort((a, b) => {
    if (a.cutOrderIndex == null && b.cutOrderIndex == null) return 0;
    if (a.cutOrderIndex == null) return 1;
    if (b.cutOrderIndex == null) return -1;
    return a.cutOrderIndex - b.cutOrderIndex;
  });

  return {
    segments,
    bounds,
    totalDistance,
    events,
    operationSpans,
    previewOffset,
    jobs,
  };
}

/** Scan top-to-bottom for JOB header blocks. Each job's metadata block
 *  follows the `; === JOB N/M: name ===` separator; the block ends when
 *  the next non-comment line appears (gcode body) or another JOB header
 *  starts. `endLine` is filled in by the caller once the total line count
 *  is known. */
function parseJobSpans(lines: string[]): JobSpan[] {
  const jobs: JobSpan[] = [];
  const headerPattern = /^===\s*JOB\s+(\d+)\/(\d+)\s*:\s*(.*?)\s*===\s*$/;

  for (let i = 0; i < lines.length; i += 1) {
    const comment = commentText(lines[i]);
    if (comment == null) continue;
    const header = comment.match(headerPattern);
    if (!header) continue;

    const startLine = i + 1;
    const jobIndex = Number.parseInt(header[1]!, 10);
    const jobTotal = Number.parseInt(header[2]!, 10);
    const jobName = header[3]!.trim();

    let jobId = "";
    let bounds: JobSpan["bounds"] = null;
    let anchor: PathAnchor = "Center";
    let crossOffsetFromArtboardBL: { x: number; y: number } | null = null;
    let previewOffset: { x: number; y: number } | null = null;
    let isBigSpanner = false;

    for (let k = i + 1; k < lines.length; k += 1) {
      const kComment = commentText(lines[k]);
      if (kComment == null) break;

      if (headerPattern.test(kComment)) break;
      const kv = kComment.match(/^([A-Z_][A-Z0-9_]*)\s*:\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1]!;
      const value = kv[2]!.trim();

      if (key === "JOB_ID") {
        jobId = value;
      } else if (key === "JOB_NAME") {
        // The header's `name` is authoritative; this key is parsed for
        // completeness but currently only used as a cross-check.
      } else if (key === "JOB_BOUNDS") {
        const m = value.match(
          /X\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*,?\s*Y\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/,
        );
        if (m) {
          bounds = {
            minX: Number.parseFloat(m[1]!),
            maxX: Number.parseFloat(m[2]!),
            minY: Number.parseFloat(m[3]!),
            maxY: Number.parseFloat(m[4]!),
          };
        }
      } else if (key === "JOB_ANCHOR") {
        anchor = (value as PathAnchor) ?? "Center";
      } else if (key === "JOB_CROSS_OFFSET_FROM_ARTBOARD_BL") {
        const m = value.match(
          /X\s+(-?\d+(?:\.\d+)?)\s*,?\s*Y\s+(-?\d+(?:\.\d+)?)/,
        );
        if (m) {
          crossOffsetFromArtboardBL = {
            x: Number.parseFloat(m[1]!),
            y: Number.parseFloat(m[2]!),
          };
        }
      } else if (key === "JOB_PREVIEW_OFFSET") {
        const m = value.match(
          /X\s+(-?\d+(?:\.\d+)?)\s*,?\s*Y\s+(-?\d+(?:\.\d+)?)/,
        );
        if (m) {
          previewOffset = {
            x: Number.parseFloat(m[1]!),
            y: Number.parseFloat(m[2]!),
          };
        }
      } else if (key === "JOB_BIG_SPANNER") {
        isBigSpanner = value.toLowerCase() === "true";
      }
    }

    jobs.push({
      jobId: jobId || `job-${jobIndex}`,
      jobName,
      jobIndex,
      jobTotal,
      bounds,
      anchor,
      crossOffsetFromArtboardBL: crossOffsetFromArtboardBL ?? previewOffset ?? { x: 0, y: 0 },
      previewOffset: previewOffset ?? crossOffsetFromArtboardBL ?? { x: 0, y: 0 },
      startLine,
      endLine: lines.length, // filled in by caller
      isBigSpanner,
    });
  }

  return jobs;
}

function parsePreviewOffset(gcode: string): { x: number; y: number } {
  for (const rawLine of gcode.split(/\r?\n/)) {
    const comment = commentText(rawLine);
    if (comment == null) continue;
    const match = comment.match(
      /^PREVIEW_OFFSET:\s*X\s+(-?\d+(?:\.\d+)?)(?:\s*,)?\s*Y\s+(-?\d+(?:\.\d+)?)/i,
    );
    if (!match) continue;

    const x = Number.parseFloat(match[1]!);
    const y = Number.parseFloat(match[2]!);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
  }

  return { x: 0, y: 0 };
}

function completeParsedJobs(jobs: JobSpan[], segments: ParsedSegment[]): void {
  if (jobs.length === 0 || segments.length === 0) return;

  const segmentsByJob = new Map<string, ParsedSegment[]>();
  for (const segment of segments) {
    if (!segment.jobId) continue;
    const list = segmentsByJob.get(segment.jobId) ?? [];
    list.push(segment);
    segmentsByJob.set(segment.jobId, list);
  }

  for (const job of jobs) {
    if (job.bounds) continue;
    const jobSegments = segmentsByJob.get(job.jobId);
    if (!jobSegments || jobSegments.length === 0) continue;

    const worldBounds = boundsFromSegments(jobSegments);
    job.bounds = {
      minX: worldBounds.minX - job.previewOffset.x,
      minY: worldBounds.minY - job.previewOffset.y,
      maxX: worldBounds.maxX - job.previewOffset.x,
      maxY: worldBounds.maxY - job.previewOffset.y,
    };
  }
}

function boundsFromSegments(segments: ParsedSegment[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const segment of segments) {
    minX = Math.min(minX, segment.start.x, segment.end.x);
    minY = Math.min(minY, segment.start.y, segment.end.y);
    maxX = Math.max(maxX, segment.start.x, segment.end.x);
    maxY = Math.max(maxY, segment.start.y, segment.end.y);
  }

  return { minX, minY, maxX, maxY };
}

function commentText(rawLine: string): string | null {
  const semicolonIndex = rawLine.indexOf(";");
  if (semicolonIndex >= 0) {
    return rawLine.slice(semicolonIndex + 1).trim();
  }

  const paren = rawLine.trim().match(/^\((.*)\)$/);
  return paren ? paren[1]!.trim() : null;
}

export function sampleProgramAtDistance(
  program: ParsedProgram,
  requestedDistance: number,
): PlaybackSample {
  if (program.segments.length === 0) {
    return {
      distance: 0,
      segmentIndex: -1,
      segment: null,
      position: { x: 0, y: 0, z: 0 },
      motionKind: "rapid",
      operationId: null,
    };
  }

  const distance = clamp(requestedDistance, 0, program.totalDistance);
  const finalSegment = program.segments.at(-1)!;
  if (distance >= program.totalDistance) {
    return {
      distance,
      segmentIndex: program.segments.length - 1,
      segment: finalSegment,
      position: finalSegment.end,
      motionKind: finalSegment.motionKind,
      operationId: finalSegment.operationId,
    };
  }

  const segmentIndex = program.segments.findIndex(
    (segment) => distance <= segment.cumulativeDistanceEnd,
  );
  const segment = program.segments[Math.max(0, segmentIndex)];
  const spanDistance = segment.distance || 1;
  const t = clamp(
    (distance - segment.cumulativeDistanceStart) / spanDistance,
    0,
    1,
  );

  return {
    distance,
    segmentIndex,
    segment,
    position: {
      x: segment.start.x + (segment.end.x - segment.start.x) * t,
      y: segment.start.y + (segment.end.y - segment.start.y) * t,
      z: segment.start.z + (segment.end.z - segment.start.z) * t,
    },
    motionKind: segment.motionKind,
    operationId: segment.operationId,
  };
}

/**
 * Expand a G2 (clockwise) / G3 (counter-clockwise) arc into a polyline of
 * intermediate points in the XY plane (Z is linearly interpolated for helix
 * arcs, though svg2gcode does not emit those). Accepts either `R<radius>` or
 * `I<dx>` / `J<dy>` center-offset form.
 *
 * Returns the list of points ending at `end` (excluding `start`).
 */
function expandArc(
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
  r: number | null,
  i: number | null,
  j: number | null,
  clockwise: boolean,
): Array<{ x: number; y: number; z: number }> {
  let cx: number;
  let cy: number;

  if (i != null || j != null) {
    cx = start.x + (i ?? 0);
    cy = start.y + (j ?? 0);
  } else if (r != null) {
    // Solve for center given chord endpoints and radius (signed R convention).
    const mx = (start.x + end.x) / 2;
    const my = (start.y + end.y) / 2;
    const chordDx = end.x - start.x;
    const chordDy = end.y - start.y;
    const chordLen = Math.hypot(chordDx, chordDy);
    if (chordLen <= 1.0e-9) {
      return [end];
    }
    const absR = Math.abs(r);
    const h2 = absR * absR - (chordLen / 2) * (chordLen / 2);
    const h = h2 > 0 ? Math.sqrt(h2) : 0;
    // Perpendicular to chord (rotate chord 90°).
    const perpX = -chordDy / chordLen;
    const perpY = chordDx / chordLen;
    // R>0 takes shorter arc; R<0 takes longer arc. Clockwise flips side.
    const longArc = r < 0;
    const sideSign = clockwise === longArc ? 1 : -1;
    cx = mx + sideSign * perpX * h;
    cy = my + sideSign * perpY * h;
  } else {
    // No arc info — fall back to straight line.
    return [end];
  }

  const radius = Math.hypot(start.x - cx, start.y - cy);
  if (radius <= 1.0e-9) {
    return [end];
  }

  const startAngle = Math.atan2(start.y - cy, start.x - cx);
  const endAngle = Math.atan2(end.y - cy, end.x - cx);
  let sweep = endAngle - startAngle;
  if (clockwise) {
    if (sweep >= 0) sweep -= 2 * Math.PI;
  } else {
    if (sweep <= 0) sweep += 2 * Math.PI;
  }

  const arcLen = Math.abs(sweep) * radius;
  // Chord tolerance 0.05 mm — small enough for smooth visuals.
  const maxChord = 0.5;
  const stepCount = Math.max(4, Math.ceil(arcLen / maxChord));

  const points: Array<{ x: number; y: number; z: number }> = [];
  for (let k = 1; k <= stepCount; k += 1) {
    const t = k / stepCount;
    const a = startAngle + sweep * t;
    points.push({
      x: cx + radius * Math.cos(a),
      y: cy + radius * Math.sin(a),
      z: start.z + (end.z - start.z) * t,
    });
  }
  // Snap the last point exactly onto `end` to avoid float drift.
  points[points.length - 1] = end;
  return points;
}

function classifyMotion(
  command: "G0" | "G1",
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
): MotionKind {
  const xyDistance = Math.hypot(end.x - start.x, end.y - start.y);
  const dz = end.z - start.z;

  if (xyDistance <= 1.0e-9 && dz < 0) {
    return "plunge";
  }
  if (xyDistance <= 1.0e-9 && dz > 0) {
    return "retract";
  }
  if (command === "G0") {
    return "rapid";
  }
  return "cut";
}

function buildOperationLineMap(ranges: OperationLineRange[]) {
  const map = new Map<number, OperationLineRange>();
  for (const range of ranges) {
    for (let line = range.start_line; line <= range.end_line; line += 1) {
      map.set(line, range);
    }
  }
  return map;
}

function buildOperationSpans(
  segments: ParsedSegment[],
  ranges: OperationLineRange[],
): OperationSpan[] {
  return ranges.flatMap((range) => {
    const matchingSegments = segments.filter(
      (segment) =>
        segment.lineNumber >= range.start_line && segment.lineNumber <= range.end_line,
    );
    if (matchingSegments.length === 0) {
      return [];
    }

    return [
      {
        operationId: range.operation_id,
        operationName: range.operation_name,
        color: range.color,
        startDistance: matchingSegments[0].cumulativeDistanceStart,
        endDistance: matchingSegments.at(-1)!.cumulativeDistanceEnd,
        cutOrderIndex: range.cut_order_index ?? null,
      },
    ];
  });
}
