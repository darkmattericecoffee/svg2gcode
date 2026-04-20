# Multi-Job Gcode — Machine-Side Contract

This document specifies what the handheld-CNC firmware / controller app must do
to support the multi-job gcode emitted by ngrave-studio.

The core idea: because the router is handheld, accumulated drift over a large
cut is unavoidable. The slicer therefore partitions the program into
spatially-tight **jobs** and pauses between them so the operator can physically
reposition the baseplate and rezero. Each job is authored around its own local
zero.

---

## 1. Gcode comment grammar

The slicer emits structured `;`-comments that the controller SHOULD parse. All
keys are uppercase, `KEY: value`, one per line. A job block is delimited by a
single `=== JOB N/M: name ===` banner.

### 1.1 Program-level comments (emitted before the first job)

```
; PREVIEW_OFFSET: X <mm>, Y <mm>        ; legacy; single-job files only
; ANCHOR: <TopLeft|TopCenter|…|Center|…|BottomRight>   ; legacy; single-job only
; TOOL_DIAMETER: <mm>
; MATERIAL_THICKNESS: <mm>
```

Single-job programs keep emitting these as today — see §5.

### 1.2 Job banner + header (emitted once per job)

```
; === JOB 2/5: Left frame ===
; JOB_ID: <stable id>
; JOB_NAME: Left frame
; JOB_INDEX: 2
; JOB_TOTAL: 5
; JOB_BOUNDS: X <minX> .. <maxX>, Y <minY> .. <maxY>
; JOB_ANCHOR: Center
; JOB_CROSS_OFFSET_FROM_ARTBOARD_BL: X <mm>, Y <mm>
; JOB_PREVIEW_OFFSET: X <mm>, Y <mm>
; JOB_BIG_SPANNER: <true|false>
```

- `JOB_BOUNDS` is in **job-local** coordinates (post-anchor; one corner is
  negative, the origin is inside the bounds).
- `JOB_CROSS_OFFSET_FROM_ARTBOARD_BL` is the **physical** measurement the
  operator must scribe on the stock. X is mm from the left edge of the
  artboard, Y is mm from the bottom edge.
- `JOB_PREVIEW_OFFSET` is the shift that takes job-local coords back to the
  artboard frame — the controller uses it to render a preview aligned with
  the stock.
- `JOB_BIG_SPANNER = true` means this job cuts an outline that geometrically
  contains ≥ 2 other leaves (frame / passe-partout). UI MUST warn — see §4.

### 1.3 Per-operation comments (inside a job, unchanged from today)

```
; OPERATION_START: <id>
; OPERATION_NAME: <name>
; OPERATION_COLOR: #rrggbb
; CUT_DEPTH: <mm>
; OPERATION_END: <id>
```

### 1.4 Pause

`M0` (firmware-standard "unconditional stop") is emitted on its own line
before jobs 2..N. No arguments.

---

## 2. Playback state machine

```
 ┌─────────┐         program loaded
 │  IDLE   │────────────────────────────► READY
 └─────────┘
      │ start
      ▼
 ┌──────────┐  cut, rapid, feed …   ┌──────────────┐
 │ RUNNING  │──────────────────────►│   RUNNING    │
 └──────────┘                        └──────────────┘
      │ encounter `M0`
      ▼
 ┌──────────────────────────────────────┐
 │ PAUSED_REALIGN (blocking modal)      │
 │  • show Job N / M, name              │
 │  • show pencil-cross offset from BL  │
 │  • show local bounds preview         │
 │  • show big-spanner warning (if set) │
 │  • require "Continue" press          │
 └──────────────────────────────────────┘
      │ operator repositions, presses Continue
      │ (controller SHOULD re-zero WCS here — see §2.1)
      ▼
 RUNNING (next job)
```

### 2.1 Zeroing on resume

On `Continue`, the controller MUST treat the **current machine position** as
the local zero for the upcoming job. In practice this means issuing
`G10 L20 P1 X0 Y0 Z0` (or the firmware equivalent) before feeding the next
line of gcode. The next job's coordinates are authored around that zero, so
without re-zero the cut lands at the previous job's origin plus whatever drift
accumulated.

### 2.2 Modal copy (recommended, localisable)

> **Job N of M — "{name}"**
> Mark a pencil cross on your stock at **X {x} mm from the left edge**,
> **Y {y} mm from the bottom edge**.
> Align the baseplate center to the cross, zero the router, then press
> **Continue**.

---

## 3. Per-job rendering

The controller's preview / progress view MUST be **per-job**, not whole-file:

- Display `Job N of M` prominently. Progress bar shows
  `current_job_distance_cut / current_job_distance_total` — not a single bar
  across the whole program.
- Preview the upcoming cut from that job's bounds (use `JOB_BOUNDS` + the job
  operations that follow the header). The preview SHOULD be drawn in the
  artboard frame using `JOB_PREVIEW_OFFSET` as the local-to-world shift, so
  the cut appears where the operator just marked the cross.
- A crosshair at `JOB_CROSS_OFFSET_FROM_ARTBOARD_BL` on the stock preview
  helps the operator visually confirm they scribed the correct location.

---

## 4. `JOB_BIG_SPANNER` UI

When the header carries `JOB_BIG_SPANNER: true`, the realign modal MUST add a
second, visually distinct warning line:

> ⚠ **This job cuts an outline that encompasses other shapes.** Double-check
> stock orientation — if the big outline is cut first from a misaligned
> position, all subsequent inner jobs will land outside the frame.

The operator can still press Continue; the warning is advisory, not blocking.

---

## 5. Backward compatibility

Gcode without any `; === JOB N/M ===` banner MUST be treated as a single
implicit job:

- Use the legacy program-level `; ANCHOR` and `; PREVIEW_OFFSET` comments.
- No `M0` is emitted. If the controller encounters an `M0` in a file with no
  `JOB` headers, it SHOULD treat it as today (plain pause + manual resume) —
  the realign modal is only shown for structured multi-job files.

This means existing single-job programs produced by older slicer versions, or
by new slicer versions with **Split into jobs** toggled off, run exactly as
they do today — no surprises.

---

## 6. Example excerpt — 2-job program

```gcode
; TOOL_DIAMETER: 3.175
; MATERIAL_THICKNESS: 18.0

; === JOB 1/2: Inner cluster ===
; JOB_ID: job-a1b2c3
; JOB_NAME: Inner cluster
; JOB_INDEX: 1
; JOB_TOTAL: 2
; JOB_BOUNDS: X -42.5 .. 42.5, Y -30.0 .. 30.0
; JOB_ANCHOR: Center
; JOB_CROSS_OFFSET_FROM_ARTBOARD_BL: X 100.0, Y 150.0
; JOB_PREVIEW_OFFSET: X 100.0, Y 150.0
; JOB_BIG_SPANNER: false
; OPERATION_START: op-circle-1
; OPERATION_NAME: Cut out — Circle 1
; CUT_DEPTH: 18.0
G0 X-42.5 Y0
G1 Z-18.0 F300
G2 X42.5 Y0 I42.5 J0 F800
G2 X-42.5 Y0 I-42.5 J0
G0 Z5
; OPERATION_END: op-circle-1

M0

; === JOB 2/2: Frame ===
; JOB_ID: job-d4e5f6
; JOB_NAME: Frame
; JOB_INDEX: 2
; JOB_TOTAL: 2
; JOB_BOUNDS: X -150.0 .. 150.0, Y -100.0 .. 100.0
; JOB_ANCHOR: Center
; JOB_CROSS_OFFSET_FROM_ARTBOARD_BL: X 300.0, Y 200.0
; JOB_PREVIEW_OFFSET: X 300.0, Y 200.0
; JOB_BIG_SPANNER: true
; OPERATION_START: op-frame
; OPERATION_NAME: Cut out — Frame
; CUT_DEPTH: 18.0
G0 X-150 Y-100
G1 Z-18 F300
G1 X150 Y-100 F800
G1 X150 Y100
G1 X-150 Y100
G1 X-150 Y-100
G0 Z5
; OPERATION_END: op-frame
```

When playback reaches `M0` above, the controller pauses, shows:

> **Job 2 of 2 — "Frame"**
> Mark a pencil cross on your stock at **X 300.0 mm from the left edge**,
> **Y 200.0 mm from the bottom edge**.
> Align the baseplate center to the cross, zero the router, then press
> **Continue**.
>
> ⚠ This job cuts an outline that encompasses other shapes. Double-check
> stock orientation.

After the operator presses Continue, the controller issues
`G10 L20 P1 X0 Y0 Z0` and resumes with the Job 2 block — the frame cuts
around the freshly-scribed cross.
