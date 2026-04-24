import { useMemo } from 'react'

import type { ArtboardState } from '../../types/editor'
import type { Bounds } from '../../lib/nodeBounds'
import type { ComputedJob } from '../../lib/jobs'
import { MATERIAL_PRESETS, type MaterialPreset } from '../../lib/materialPresets'

interface LayoutDiagramProps {
  artboard: ArtboardState
  /** Inner <g> content of the design SVG (pre-built by the parent via exportToSVG). */
  designInnerSvg: string
  /** Union bounds of the design in artboard-mm (origin = artboard top-left, y grows down). */
  designBounds: Bounds | null
  jobs: ComputedJob[]
  materialPreset: MaterialPreset
}

// Extra mm reserved around the material rect for dimension lines and labels.
const DIM_PAD = 60
const LABEL_PX = 11
const TICK_LEN = 4
const DIM_OFFSET = 18

function Hdim({
  y,
  x1,
  x2,
  label,
  placement,
}: {
  y: number
  x1: number
  x2: number
  label: string
  placement: 'above' | 'below'
}) {
  const textY = placement === 'above' ? y - 4 : y + LABEL_PX
  return (
    <g>
      <line x1={x1} y1={y} x2={x2} y2={y} stroke="#333" strokeWidth={0.6} />
      <line x1={x1} y1={y - TICK_LEN} x2={x1} y2={y + TICK_LEN} stroke="#333" strokeWidth={0.6} />
      <line x1={x2} y1={y - TICK_LEN} x2={x2} y2={y + TICK_LEN} stroke="#333" strokeWidth={0.6} />
      <text
        x={(x1 + x2) / 2}
        y={textY}
        fontSize={LABEL_PX}
        textAnchor="middle"
        fill="#111"
        fontFamily="sans-serif"
      >
        {label}
      </text>
    </g>
  )
}

function Vdim({
  x,
  y1,
  y2,
  label,
  placement,
}: {
  x: number
  y1: number
  y2: number
  label: string
  placement: 'left' | 'right'
}) {
  const textX = placement === 'left' ? x - 4 : x + 4
  const anchor = placement === 'left' ? 'end' : 'start'
  return (
    <g>
      <line x1={x} y1={y1} x2={x} y2={y2} stroke="#333" strokeWidth={0.6} />
      <line x1={x - TICK_LEN} y1={y1} x2={x + TICK_LEN} y2={y1} stroke="#333" strokeWidth={0.6} />
      <line x1={x - TICK_LEN} y1={y2} x2={x + TICK_LEN} y2={y2} stroke="#333" strokeWidth={0.6} />
      <text
        x={textX}
        y={(y1 + y2) / 2 + LABEL_PX / 3}
        fontSize={LABEL_PX}
        textAnchor={anchor}
        fill="#111"
        fontFamily="sans-serif"
      >
        {label}
      </text>
    </g>
  )
}

function fmtMm(mm: number): string {
  if (Number.isNaN(mm) || !Number.isFinite(mm)) return '—'
  return `${Math.round(mm * 10) / 10} mm`
}

export function LayoutDiagram({
  artboard,
  designInnerSvg,
  designBounds,
  jobs,
  materialPreset,
}: LayoutDiagramProps) {
  const matW = artboard.width
  const matH = artboard.height

  const preset = MATERIAL_PRESETS.find((p) => p.id === materialPreset) ?? MATERIAL_PRESETS[0]

  const viewMinX = -DIM_PAD
  const viewMinY = -DIM_PAD
  const viewW = matW + DIM_PAD * 2
  const viewH = matH + DIM_PAD * 2

  const hasDesign = !!designBounds
  const dX = designBounds ? designBounds.minX : 0
  const dY = designBounds ? designBounds.minY : 0
  const dW = designBounds ? designBounds.maxX - designBounds.minX : 0
  const dH = designBounds ? designBounds.maxY - designBounds.minY : 0
  // Offset from artboard BL corner (y measured up from bottom).
  const offFromBLX = designBounds ? designBounds.minX : 0
  const offFromBLY = designBounds ? matH - designBounds.maxY : 0

  const patternId = useMemo(() => `prepare-material-${preset.id}`, [preset.id])

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`${viewMinX} ${viewMinY} ${viewW} ${viewH}`}
      className="block w-full"
      style={{ aspectRatio: `${viewW} / ${viewH}`, maxHeight: '60vh' }}
    >
      <defs>
        <pattern
          id={patternId}
          patternUnits="userSpaceOnUse"
          width={matW}
          height={matH}
          x={0}
          y={0}
        >
          <image
            href={preset.textureSrc}
            x={0}
            y={0}
            width={matW}
            height={matH}
            preserveAspectRatio="xMidYMid slice"
          />
        </pattern>
      </defs>

      {/* Material rectangle (= artboard = machinable area) */}
      <rect
        x={0}
        y={0}
        width={matW}
        height={matH}
        fill={`url(#${patternId})`}
        stroke="#222"
        strokeWidth={0.8}
      />

      {/* Design — exportToSVG normalizes the artboard origin to (0,0). */}
      {designInnerSvg ? (
        <g dangerouslySetInnerHTML={{ __html: designInnerSvg }} />
      ) : null}

      {/* Design bounding box (dashed) */}
      {hasDesign && dW > 0 && dH > 0 && (
        <rect
          x={dX}
          y={dY}
          width={dW}
          height={dH}
          fill="none"
          stroke="#dc2626"
          strokeWidth={0.7}
          strokeDasharray="3 2"
        />
      )}

      {/* Per-job anchor crosshairs */}
      {jobs.map((job, i) => {
        const cx = job.anchorPointMm.x
        const cy = job.anchorPointMm.y
        return (
          <g key={job.id}>
            <circle cx={cx} cy={cy} r={6} fill="none" stroke="#059669" strokeWidth={0.9} />
            <line x1={cx - 9} y1={cy} x2={cx + 9} y2={cy} stroke="#059669" strokeWidth={0.9} />
            <line x1={cx} y1={cy - 9} x2={cx} y2={cy + 9} stroke="#059669" strokeWidth={0.9} />
            <text
              x={cx + 8}
              y={cy - 8}
              fontSize={LABEL_PX}
              fill="#065f46"
              fontFamily="sans-serif"
              fontWeight={600}
            >
              {job.name || `Job ${i + 1}`}
            </text>
          </g>
        )
      })}

      {/* Material dimensions */}
      <Hdim y={-DIM_OFFSET} x1={0} x2={matW} label={`W ${fmtMm(matW)}`} placement="above" />
      <Vdim x={matW + DIM_OFFSET} y1={0} y2={matH} label={`H ${fmtMm(matH)}`} placement="right" />

      {/* Design reach + BL offsets */}
      {hasDesign && dW > 0 && dH > 0 && (
        <>
          <Hdim
            y={dY - 10}
            x1={dX}
            x2={dX + dW}
            label={`Design W ${fmtMm(dW)}`}
            placement="above"
          />
          <Vdim
            x={dX + dW + 10}
            y1={dY}
            y2={dY + dH}
            label={`Design H ${fmtMm(dH)}`}
            placement="right"
          />
          {/* X-offset from artboard BL (measured along the bottom edge) */}
          <Hdim
            y={matH + DIM_OFFSET / 2}
            x1={0}
            x2={dX}
            label={`X ${fmtMm(offFromBLX)}`}
            placement="above"
          />
          {/* Y-offset from artboard BL (measured along the left edge, inside the artboard) */}
          <Vdim
            x={-6}
            y1={dY + dH}
            y2={matH}
            label={`Y ${fmtMm(offFromBLY)}`}
            placement="left"
          />
        </>
      )}

      {/* Artboard BL origin marker (0,0) */}
      <g>
        <circle cx={0} cy={matH} r={2.4} fill="#1d4ed8" />
        <text
          x={4}
          y={matH - 4}
          fontSize={LABEL_PX}
          fill="#1d4ed8"
          fontFamily="sans-serif"
        >
          0,0
        </text>
      </g>
    </svg>
  )
}
