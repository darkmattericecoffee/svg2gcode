interface GeneratorFormFieldProps {
  label: string
  value: number
  unit?: string
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  onChange: (value: number) => void
}

export function GeneratorFormField({
  label,
  value,
  unit,
  min = 0.1,
  max,
  step = 0.1,
  disabled,
  onChange,
}: GeneratorFormFieldProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <label className="shrink-0 text-xs text-muted-foreground">{label}</label>
      <div className="flex items-center gap-1">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            if (Number.isFinite(v)) onChange(v)
          }}
          className="w-20 rounded border border-border bg-[var(--surface-secondary)] px-2 py-1 text-right text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus:ring-1 focus:ring-primary"
        />
        {unit && <span className="w-6 shrink-0 text-xs text-muted-foreground">{unit}</span>}
      </div>
    </div>
  )
}
