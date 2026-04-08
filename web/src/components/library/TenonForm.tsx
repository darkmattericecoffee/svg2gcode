import { useEditorStore } from '../../store'
import type { TenonParams } from '../../types/editor'
import { GeneratorFormField } from './GeneratorFormField'
import { useGeneratorForm } from './useGeneratorForm'

interface TenonFormProps {
  initialParams: TenonParams
  mode: 'new' | 'edit'
  nodeId?: string
  onPlace?: (params: TenonParams) => void
  onUpdate?: (params: TenonParams) => void
}

export function TenonForm({ initialParams, mode, nodeId, onPlace, onUpdate }: TenonFormProps) {
  const toolDiameter = useEditorStore((s) => s.machiningSettings.toolDiameter)
  const { draft, setPatch } = useGeneratorForm(initialParams, mode, nodeId)
  const p = draft as TenonParams

  return (
    <div className="space-y-4">
      {/* Shape */}
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Shape</p>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="matchToolWidth"
              checked={p.matchToolWidth}
              onChange={(e) => setPatch({ matchToolWidth: e.target.checked, width: e.target.checked ? toolDiameter : p.width })}
              className="h-3 w-3 rounded accent-primary"
            />
            <label htmlFor="matchToolWidth" className="text-xs text-muted-foreground">
              Match router bit width ({toolDiameter} mm)
            </label>
          </div>
          <GeneratorFormField
            label="Width"
            value={p.matchToolWidth ? toolDiameter : p.width}
            unit="mm"
            disabled={p.matchToolWidth}
            onChange={(v) => setPatch({ width: v })}
          />
          <GeneratorFormField
            label="Height"
            value={p.height}
            unit="mm"
            onChange={(v) => setPatch({ height: v })}
          />
        </div>
      </div>

      {/* Distribution */}
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Distribution</p>
        <div className="space-y-2">
          <GeneratorFormField label="Columns" value={p.colCount} min={1} max={50} step={1} onChange={(v) => setPatch({ colCount: Math.max(1, Math.round(v)) })} />
          <GeneratorFormField label="Col spacing" value={p.colSpacing} unit="mm" onChange={(v) => setPatch({ colSpacing: v })} />
          <GeneratorFormField label="Rows" value={p.rowCount} min={1} max={50} step={1} onChange={(v) => setPatch({ rowCount: Math.max(1, Math.round(v)) })} />
          <GeneratorFormField label="Row spacing" value={p.rowSpacing} unit="mm" onChange={(v) => setPatch({ rowSpacing: v })} />
        </div>
      </div>

      {/* Output type */}
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Output</p>
        {p.matchToolWidth ? (
          <div className="rounded bg-[var(--surface-secondary)] px-2 py-1 text-xs text-muted-foreground">
            Contour (forced for bit-width slots)
          </div>
        ) : (
          <div className="flex gap-1">
            {(['contour', 'pocket'] as const).map((type) => (
              <button
                key={type}
                onClick={() => setPatch({ outputType: type })}
                className={`flex-1 rounded px-2 py-1 text-xs capitalize transition-colors ${
                  p.outputType === type
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-[var(--surface-secondary)] text-muted-foreground hover:text-foreground'
                }`}
              >
                {type}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Action button */}
      {mode === 'new' && onPlace && (
        <button
          onClick={() => onPlace(p)}
          className="w-full rounded bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Place on artboard
        </button>
      )}
      {mode === 'edit' && onUpdate && (
        <button
          onClick={() => onUpdate(p)}
          className="w-full rounded bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Apply changes
        </button>
      )}
    </div>
  )
}
