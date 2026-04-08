import type { ScallopFrameParams } from '../../types/editor'
import { GeneratorFormField } from './GeneratorFormField'
import { useGeneratorForm } from './useGeneratorForm'

interface ScallopFrameFormProps {
  initialParams: ScallopFrameParams
  mode: 'new' | 'edit'
  nodeId?: string
  onPlace?: (params: ScallopFrameParams) => void
  onUpdate?: (params: ScallopFrameParams) => void
}

export function ScallopFrameForm({
  initialParams,
  mode,
  nodeId,
  onPlace,
  onUpdate,
}: ScallopFrameFormProps) {
  const { draft, setPatch } = useGeneratorForm(initialParams, mode, nodeId)
  const p = draft as ScallopFrameParams

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Shape</p>
        <div className="space-y-2">
          <GeneratorFormField label="Width" value={p.width} unit="mm" min={2} onChange={(value) => setPatch({ width: value })} />
          <GeneratorFormField label="Height" value={p.height} unit="mm" min={2} onChange={(value) => setPatch({ height: value })} />
          <GeneratorFormField
            label="Min scallop"
            value={p.minScallopSize}
            unit="mm"
            min={1}
            onChange={(value) => setPatch({ minScallopSize: value })}
          />
        </div>
      </div>

      <div>
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Output</p>
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
      </div>

      {mode === 'new' && onPlace && (
        <button
          onClick={() => onPlace(p)}
          className="w-full rounded-xl bg-primary px-3 py-2.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Place on artboard
        </button>
      )}
      {mode === 'edit' && onUpdate && (
        <button
          onClick={() => onUpdate(p)}
          className="w-full rounded-xl bg-primary px-3 py-2.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Apply changes
        </button>
      )}
    </div>
  )
}
