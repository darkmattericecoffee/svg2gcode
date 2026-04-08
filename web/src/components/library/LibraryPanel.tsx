import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Sparkles } from '@gravity-ui/icons'

import { useEditorStore } from '../../store'
import type {
  DowelHoleParams,
  GeneratorParams,
  GroupNode,
  TenonParams,
} from '../../types/editor'
import { DowelHoleForm } from './DowelHoleForm'
import { TenonForm } from './TenonForm'

// ---- Default params ----

const DEFAULT_TENON: TenonParams = {
  kind: 'tenon',
  name: 'Tenon',
  width: 10,
  height: 20,
  matchToolWidth: false,
  rowCount: 1,
  colCount: 1,
  rowSpacing: 30,
  colSpacing: 30,
  outputType: 'pocket',
}

const DEFAULT_DOWEL: DowelHoleParams = {
  kind: 'dowelHole',
  name: 'Dowel Hole',
  diameter: 8,
  matchToolDiameter: false,
  rowCount: 1,
  colCount: 1,
  rowSpacing: 30,
  colSpacing: 30,
  outputType: 'pocket',
}

// ---- Generator registry ----

interface GeneratorCard {
  kind: GeneratorParams['kind']
  label: string
  description: string
  defaultParams: GeneratorParams
}

const GENERATORS: GeneratorCard[] = [
  {
    kind: 'tenon',
    label: 'Tenon / Domino',
    description: 'Rectangular mortise pocket or contour for tenon joints',
    defaultParams: DEFAULT_TENON,
  },
  {
    kind: 'dowelHole',
    label: 'Dowel Hole',
    description: 'Circular pocket or contour for dowel pins',
    defaultParams: DEFAULT_DOWEL,
  },
]

// ---- Main panel ----

export function LibraryPanel() {
  const selectedIds = useEditorStore((s) => s.selectedIds)
  const nodesById = useEditorStore((s) => s.nodesById)
  const setLeftPanelTab = useEditorStore((s) => s.setLeftPanelTab)
  const placeGenerator = useEditorStore((s) => s.placeGenerator)
  const updateGeneratorParams = useEditorStore((s) => s.updateGeneratorParams)

  const [query, setQuery] = useState('')
  // Which generator card is open for a new placement
  const [activeKind, setActiveKind] = useState<GeneratorParams['kind'] | null>(null)

  // Derive the selected generator node (if any)
  const selectedGeneratorNode = useMemo(() => {
    if (selectedIds.length !== 1) return null
    const node = nodesById[selectedIds[0]]
    if (!node || node.type !== 'group') return null
    return (node as GroupNode).generatorMetadata ? (node as GroupNode) : null
  }, [selectedIds, nodesById])

  // Auto-switch to Library tab and close new-form when a generator is selected
  useEffect(() => {
    if (selectedGeneratorNode) {
      setLeftPanelTab('library')
      setActiveKind(null)
    }
  }, [selectedGeneratorNode?.id, setLeftPanelTab])

  // ---- Edit mode: selected generator is being edited ----
  if (selectedGeneratorNode) {
    const params = selectedGeneratorNode.generatorMetadata!.params
    const nodeId = selectedGeneratorNode.id

    return (
      <div className="flex h-full flex-col overflow-hidden">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="truncate text-xs font-medium">
            {selectedGeneratorNode.name}
          </span>
        </div>

        {/* Form */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {params.kind === 'tenon' ? (
            <TenonForm
              initialParams={params}
              mode="edit"
              nodeId={nodeId}
              onUpdate={(p) => updateGeneratorParams(nodeId, p)}
            />
          ) : (
            <DowelHoleForm
              initialParams={params}
              mode="edit"
              nodeId={nodeId}
              onUpdate={(p) => updateGeneratorParams(nodeId, p)}
            />
          )}
        </div>
      </div>
    )
  }

  // ---- New-form mode: a card was clicked ----
  if (activeKind !== null) {
    const card = GENERATORS.find((g) => g.kind === activeKind)!

    return (
      <div className="flex h-full flex-col overflow-hidden">
        {/* Header with back button */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <button
            onClick={() => setActiveKind(null)}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            aria-label="Back to library"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <span className="truncate text-xs font-medium">{card.label}</span>
        </div>

        {/* Form */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {activeKind === 'tenon' ? (
            <TenonForm
              initialParams={DEFAULT_TENON}
              mode="new"
              onPlace={(p) => {
                placeGenerator(p)
                setActiveKind(null)
              }}
            />
          ) : (
            <DowelHoleForm
              initialParams={DEFAULT_DOWEL}
              mode="new"
              onPlace={(p) => {
                placeGenerator(p)
                setActiveKind(null)
              }}
            />
          )}
        </div>
      </div>
    )
  }

  // ---- Browse mode: show generator cards ----
  const filteredGenerators = GENERATORS.filter(
    (g) =>
      !query.trim() ||
      g.label.toLowerCase().includes(query.trim().toLowerCase()) ||
      g.description.toLowerCase().includes(query.trim().toLowerCase()),
  )

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Search */}
      <div className="shrink-0 p-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search generators…"
          className="w-full rounded border border-border bg-[var(--surface-secondary)] px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      {/* Cards */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {filteredGenerators.length === 0 ? (
          <p className="px-1 py-4 text-center text-xs text-muted-foreground">No generators found</p>
        ) : (
          <div className="space-y-1.5">
            {filteredGenerators.map((card) => (
              <button
                key={card.kind}
                onClick={() => setActiveKind(card.kind)}
                className="group/card flex w-full flex-col gap-0.5 rounded-lg border border-border bg-[var(--surface-secondary)] px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-[var(--surface-tertiary)]"
              >
                <div className="flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary/70 transition-colors group-hover/card:text-primary" />
                  <span className="text-xs font-medium text-foreground">{card.label}</span>
                </div>
                <p className="pl-[1.375rem] text-xs text-muted-foreground">{card.description}</p>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
