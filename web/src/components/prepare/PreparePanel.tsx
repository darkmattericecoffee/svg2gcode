import { useMemo, useRef, useState } from 'react'
import { Button } from '@heroui/react'
import ArrowDownToSquareIcon from '@gravity-ui/icons/esm/ArrowDownToSquare.js'

import { AppIcon } from '../../lib/icons'
import { useEditorStore } from '../../store'
import { MATERIAL_PRESETS, type MaterialPreset } from '../../lib/materialPresets'
import { computeCutPlan } from '../../lib/jobs'
import { getNodePreviewBounds, type Bounds } from '../../lib/nodeBounds'
import { exportToSVG } from '../../lib/svgExport'
import { exportPreparePdf } from '../../lib/exportPreparePdf'
import { LayoutDiagram } from './LayoutDiagram'

interface PreparePanelProps {
  projectName: string
  materialPreset: MaterialPreset
}

function unionBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b
  if (!b) return a
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

function fmt(value: number | null | undefined, unit: string = 'mm', digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const f = Math.round(value * 10 ** digits) / 10 ** digits
  return `${f} ${unit}`
}

function extractDesignInnerSvg(svgText: string): string {
  // exportToSVG wraps all content in <g transform="translate(-artX -artY)">.
  // We grab that <g> node's outerHTML so its transform is preserved, then
  // splice it into the layout diagram.
  if (typeof DOMParser === 'undefined') return ''
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const g = doc.querySelector('svg > g')
  return g ? g.outerHTML : ''
}

export function PreparePanel({ projectName, materialPreset }: PreparePanelProps) {
  const artboard = useEditorStore((s) => s.artboard)
  const nodesById = useEditorStore((s) => s.nodesById)
  const rootIds = useEditorStore((s) => s.rootIds)
  const machiningSettings = useEditorStore((s) => s.machiningSettings)

  const rootRef = useRef<HTMLDivElement>(null)
  const [isExporting, setIsExporting] = useState(false)

  const preset = MATERIAL_PRESETS.find((p) => p.id === materialPreset) ?? MATERIAL_PRESETS[0]

  const { jobs, designBounds, designInnerSvg } = useMemo(() => {
    const plan = computeCutPlan(rootIds, nodesById, machiningSettings, artboard)

    let bounds: Bounds | null = null
    for (const id of rootIds) {
      const node = nodesById[id]
      if (!node) continue
      const b = getNodePreviewBounds(node, nodesById)
      bounds = unionBounds(bounds, b)
    }

    const svgText = exportToSVG(nodesById, rootIds, artboard)
    const inner = extractDesignInnerSvg(svgText)

    return { jobs: plan.jobs, designBounds: bounds, designInnerSvg: inner }
  }, [artboard, machiningSettings, nodesById, rootIds])

  const generatedAt = useMemo(() => new Date().toLocaleString(), [])

  const totalLeaves = jobs.reduce((sum, j) => sum + j.nodeIds.length, 0)

  const handleExport = async () => {
    if (!rootRef.current) return
    setIsExporting(true)
    try {
      const safeName = (projectName || 'project').replace(/[^\w.\-]+/g, '_')
      await exportPreparePdf(rootRef.current, {
        filename: `${safeName}-prepare.pdf`,
      })
    } finally {
      setIsExporting(false)
    }
  }

  const passMode = machiningSettings.maxStepdown != null ? 'stepdown' : 'passes'
  const designOffsetX = designBounds?.minX ?? 0
  const designOffsetYFromTop = designBounds?.minY ?? 0
  const designOffsetYFromBL =
    designBounds != null ? artboard.height - designBounds.maxY : 0
  const designW = designBounds ? designBounds.maxX - designBounds.minX : 0
  const designH = designBounds ? designBounds.maxY - designBounds.minY : 0

  return (
    <div className="h-full w-full overflow-auto bg-neutral-200 px-6 py-6">
      <div className="mx-auto flex max-w-5xl items-center justify-between pb-4">
        <div className="text-sm text-neutral-700">
          Review the layout, cut list and offsets before machining. Export as PDF to keep a record.
        </div>
        <Button
          className="rounded-full bg-emerald-600 px-4 gap-1.5 text-sm font-medium text-white hover:bg-emerald-500"
          size="sm"
          onPress={handleExport}
          isDisabled={isExporting}
        >
          <AppIcon icon={ArrowDownToSquareIcon} className="h-4 w-4" />
          {isExporting ? 'Exporting…' : 'Export PDF'}
        </Button>
      </div>

      <div
        ref={rootRef}
        className="mx-auto max-w-5xl space-y-6 rounded-lg bg-white p-8 text-neutral-900 shadow-sm"
      >
        {/* Header */}
        <header className="flex items-start justify-between border-b border-neutral-200 pb-4">
          <div>
            <h1 className="text-2xl font-semibold">{projectName || 'Untitled project'}</h1>
            <p className="mt-1 text-sm text-neutral-500">
              Generated {generatedAt} · Material: {preset.label}
            </p>
          </div>
          <div className="text-right text-xs text-neutral-500">
            <div>
              Tool: Ø{fmt(machiningSettings.toolDiameter, 'mm')} {machiningSettings.toolShape}
            </div>
            <div>
              {jobs.length} job{jobs.length === 1 ? '' : 's'} · {totalLeaves} cut
              {totalLeaves === 1 ? '' : 's'}
            </div>
          </div>
        </header>

        {/* Layout diagram */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Layout
          </h2>
          <div className="overflow-hidden rounded-md border border-neutral-200 bg-neutral-50 p-4">
            <LayoutDiagram
              artboard={artboard}
              designInnerSvg={designInnerSvg}
              designBounds={designBounds}
              jobs={jobs}
              materialPreset={materialPreset}
            />
          </div>
          <p className="mt-2 text-xs text-neutral-500">
            Material: {fmt(artboard.width)} × {fmt(artboard.height)}. Design bounds in
            dashed red. Job anchor crosshairs in green.
          </p>
        </section>

        {/* Stock + material + machining in two columns */}
        <section className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <InfoTable
            title="Material"
            rows={[
              ['Preset', preset.label],
              ['Width', fmt(artboard.width)],
              ['Height', fmt(artboard.height)],
              ['Depth', fmt(artboard.thickness)],
            ]}
          />
          <InfoTable
            title="Machining"
            rows={[
              ['Tool diameter', fmt(machiningSettings.toolDiameter)],
              ['Tool shape', machiningSettings.toolShape],
              ['Target depth', fmt(machiningSettings.defaultDepthMm)],
              passMode === 'passes'
                ? ['Passes', `${machiningSettings.passCount}`]
                : ['Max stepdown', fmt(machiningSettings.maxStepdown)],
              ['Cut feed', fmt(machiningSettings.cutFeedrate, 'mm/min', 0)],
              ['Plunge feed', fmt(machiningSettings.plungeFeedrate, 'mm/min', 0)],
              ['Tabs', machiningSettings.tabsEnabled ? 'Yes' : 'No'],
              ['Work anchor', machiningSettings.pathAnchor],
            ]}
          />
        </section>

        {/* Design totals */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Design totals
          </h2>
          {designBounds ? (
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
              <Stat label="Width" value={fmt(designW)} />
              <Stat label="Height" value={fmt(designH)} />
              <Stat label="X offset from BL" value={fmt(designOffsetX)} />
              <Stat label="Y offset from BL" value={fmt(designOffsetYFromBL)} />
              <Stat label="X offset from TL" value={fmt(designOffsetX)} />
              <Stat label="Y offset from TL" value={fmt(designOffsetYFromTop)} />
              <Stat
                label="Reach right"
                value={fmt(artboard.width - (designBounds.maxX))}
              />
              <Stat
                label="Reach top"
                value={fmt(designBounds.minY)}
              />
            </div>
          ) : (
            <p className="text-sm text-neutral-500">No design geometry placed yet.</p>
          )}
        </section>

        {/* Jobs table */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Jobs ({jobs.length})
          </h2>
          {jobs.length === 0 ? (
            <p className="text-sm text-neutral-500">No jobs — place geometry on the artboard.</p>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500">
                  <Th>#</Th>
                  <Th>Name</Th>
                  <Th className="text-right">Cuts</Th>
                  <Th>Anchor</Th>
                  <Th className="text-right">X from BL</Th>
                  <Th className="text-right">Y from BL</Th>
                  <Th className="text-right">Width</Th>
                  <Th className="text-right">Height</Th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job, i) => {
                  const w = job.boundsMm.maxX - job.boundsMm.minX
                  const h = job.boundsMm.maxY - job.boundsMm.minY
                  return (
                    <tr
                      key={job.id}
                      className="border-b border-neutral-200 last:border-b-0"
                    >
                      <Td>{i + 1}</Td>
                      <Td>{job.name}</Td>
                      <Td className="text-right tabular-nums">{job.nodeIds.length}</Td>
                      <Td>{job.pathAnchor}</Td>
                      <Td className="text-right tabular-nums">
                        {fmt(job.crossOffsetFromArtboardBL.x)}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {fmt(job.crossOffsetFromArtboardBL.y)}
                      </Td>
                      <Td className="text-right tabular-nums">{fmt(w)}</Td>
                      <Td className="text-right tabular-nums">{fmt(h)}</Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  )
}

function InfoTable({
  title,
  rows,
}: {
  title: string
  rows: [string, string][]
}) {
  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h2>
      <table className="w-full border-collapse text-sm">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} className="border-b border-neutral-200 last:border-b-0">
              <td className="py-1.5 pr-4 text-neutral-600">{label}</td>
              <td className="py-1.5 text-right font-medium tabular-nums">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
    </div>
  )
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`py-2 pr-3 font-medium ${className}`}>{children}</th>
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`py-1.5 pr-3 ${className}`}>{children}</td>
}
