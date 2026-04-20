import { useEffect, useMemo, useRef, useState } from 'react'

import {
  fetchGoogleFontList,
  getApiKey,
  getCachedFont,
  loadGoogleFont,
  type GoogleFontFamily,
} from '../../lib/fonts/googleFonts'
import { useEditorStore } from '../../store'
import type { TextParams } from '../../types/editor'
import { GeneratorFormField } from './GeneratorFormField'
import { useGeneratorForm } from './useGeneratorForm'

const PT_TO_MM = 25.4 / 72
const MM_TO_PT = 72 / 25.4

interface TextFormProps {
  initialParams: TextParams
  mode: 'new' | 'edit'
  nodeId?: string
  onPlace?: (params: TextParams) => void
  onUpdate?: (params: TextParams) => void
}

export function TextForm({ initialParams, mode, nodeId, onPlace, onUpdate }: TextFormProps) {
  const { draft, setPatch } = useGeneratorForm(initialParams, mode, nodeId)
  const p = draft as TextParams

  const [families, setFamilies] = useState<GoogleFontFamily[]>([])
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [fontLoading, setFontLoading] = useState(false)
  const [fontError, setFontError] = useState<string | null>(null)
  const [fontReady, setFontReady] = useState(() => Boolean(getCachedFont(p.fontFamily, p.fontVariant)))
  const [familyQuery, setFamilyQuery] = useState('')
  const [familyOpen, setFamilyOpen] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const focusTextRequestId = useEditorStore((s) => s.ui.focusTextRequestId)
  const consumeFocusTextRequest = useEditorStore((s) => s.consumeFocusTextRequest)

  useEffect(() => {
    if (mode === 'edit' && focusTextRequestId && focusTextRequestId === nodeId) {
      textareaRef.current?.focus()
      textareaRef.current?.select()
      consumeFocusTextRequest()
    }
  }, [focusTextRequestId, mode, nodeId, consumeFocusTextRequest])

  // Load the Google Fonts catalog once on mount
  useEffect(() => {
    let cancelled = false
    setCatalogLoading(true)
    fetchGoogleFontList()
      .then((list) => {
        if (cancelled) return
        setFamilies(list)
        setCatalogError(null)
      })
      .catch((err: Error) => {
        if (cancelled) return
        setCatalogError(err.message)
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // (Re)load the selected font whenever family+variant changes
  useEffect(() => {
    let cancelled = false
    const cached = getCachedFont(p.fontFamily, p.fontVariant)
    if (cached) {
      setFontReady(true)
      setFontError(null)
      return
    }
    setFontReady(false)
    setFontLoading(true)
    setFontError(null)
    loadGoogleFont(p.fontFamily, p.fontVariant)
      .then(() => {
        if (cancelled) return
        setFontReady(true)
        if (mode === 'edit' && nodeId) {
          // Trigger a regen now that the font is in cache
          setPatch({})
        }
      })
      .catch((err: Error) => {
        if (cancelled) return
        setFontError(err.message)
      })
      .finally(() => {
        if (!cancelled) setFontLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.fontFamily, p.fontVariant])

  const selectedFamily = useMemo(
    () => families.find((f) => f.family === p.fontFamily),
    [families, p.fontFamily],
  )

  const filteredFamilies = useMemo(() => {
    const q = familyQuery.trim().toLowerCase()
    const list = q
      ? families.filter((f) => f.family.toLowerCase().includes(q))
      : families
    return list.slice(0, 60)
  }, [families, familyQuery])

  const sizeMm = p.fontSizePt * PT_TO_MM

  const setSizePt = (pt: number) => setPatch({ fontSizePt: Math.max(1, pt) })
  const setSizeMm = (mm: number) => setPatch({ fontSizePt: Math.max(1, mm * MM_TO_PT) })

  const chooseFamily = (family: string) => {
    const entry = families.find((f) => f.family === family)
    const nextVariant = entry
      ? entry.variants.includes(p.fontVariant)
        ? p.fontVariant
        : entry.variants.includes('regular')
          ? 'regular'
          : entry.variants[0]
      : p.fontVariant
    setPatch({ fontFamily: family, fontVariant: nextVariant })
    setFamilyOpen(false)
    setFamilyQuery('')
  }

  const canCommit = fontReady && !fontLoading && !fontError

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Content</p>
        <textarea
          ref={textareaRef}
          value={p.text}
          onChange={(e) => setPatch({ text: e.target.value })}
          rows={2}
          placeholder="Your text…"
          className="w-full rounded border border-border bg-[var(--surface-secondary)] px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Font</p>
        {!getApiKey() ? (
          <p className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
            Set <code>VITE_GOOGLE_FONTS_API_KEY</code> in <code>web/.env.local</code> to enable Google Fonts.
          </p>
        ) : catalogError ? (
          <p className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
            {catalogError}
          </p>
        ) : (
          <div className="space-y-2">
            <div className="relative">
              <button
                type="button"
                onClick={() => setFamilyOpen((v) => !v)}
                className="flex w-full items-center justify-between rounded border border-border bg-[var(--surface-secondary)] px-2 py-1.5 text-left text-xs text-foreground hover:border-primary/50"
              >
                <span className="truncate">{p.fontFamily}</span>
                <span className="text-muted-foreground">{familyOpen ? '▴' : '▾'}</span>
              </button>
              {familyOpen && (
                <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-hidden rounded border border-border bg-[var(--surface)] shadow-lg">
                  <input
                    autoFocus
                    type="text"
                    placeholder={catalogLoading ? 'Loading fonts…' : 'Search fonts'}
                    value={familyQuery}
                    onChange={(e) => setFamilyQuery(e.target.value)}
                    className="w-full border-b border-border bg-transparent px-2 py-1.5 text-xs text-foreground focus:outline-none"
                  />
                  <div className="max-h-56 overflow-y-auto">
                    {filteredFamilies.length === 0 ? (
                      <div className="px-2 py-2 text-[11px] text-muted-foreground">
                        {catalogLoading ? 'Loading…' : 'No matches'}
                      </div>
                    ) : (
                      filteredFamilies.map((f) => (
                        <button
                          key={f.family}
                          type="button"
                          onClick={() => chooseFamily(f.family)}
                          className={`flex w-full items-center justify-between px-2 py-1.5 text-left text-xs hover:bg-[var(--surface-secondary)] ${
                            f.family === p.fontFamily ? 'text-primary' : 'text-foreground'
                          }`}
                        >
                          <span className="truncate">{f.family}</span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">{f.category}</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            {selectedFamily && selectedFamily.variants.length > 1 && (
              <select
                value={p.fontVariant}
                onChange={(e) => setPatch({ fontVariant: e.target.value })}
                className="w-full rounded border border-border bg-[var(--surface-secondary)] px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {selectedFamily.variants.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            )}

            <div className="text-[11px] text-muted-foreground">
              {fontLoading ? 'Loading font…' : fontError ? (
                <span className="text-destructive">{fontError}</span>
              ) : fontReady ? (
                'Font loaded'
              ) : 'Not loaded'}
            </div>
          </div>
        )}
      </div>

      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Size</p>
        <div className="space-y-2">
          <GeneratorFormField
            label="Size (pt)"
            value={round2(p.fontSizePt)}
            unit="pt"
            min={1}
            step={1}
            onChange={setSizePt}
          />
          <GeneratorFormField
            label="Height (mm)"
            value={round2(sizeMm)}
            unit="mm"
            min={0.1}
            step={0.1}
            onChange={setSizeMm}
          />
          <GeneratorFormField
            label="Line height"
            value={round2(p.lineHeight)}
            unit="×"
            min={0.5}
            max={3}
            step={0.05}
            onChange={(v) => setPatch({ lineHeight: v })}
          />
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Alignment</p>
        <div className="flex gap-1">
          {(['start', 'middle', 'end'] as const).map((a) => (
            <button
              key={a}
              onClick={() => setPatch({ align: a })}
              className={`flex-1 rounded px-2 py-1 text-xs capitalize transition-colors ${
                p.align === a
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-[var(--surface-secondary)] text-muted-foreground hover:text-foreground'
              }`}
            >
              {a === 'start' ? 'Left' : a === 'middle' ? 'Center' : 'Right'}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Output</p>
        <div className="flex gap-1">
          {(['contour', 'pocket', 'outline'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setPatch({ outputType: t })}
              className={`flex-1 rounded px-2 py-1 text-xs capitalize transition-colors ${
                p.outputType === t
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-[var(--surface-secondary)] text-muted-foreground hover:text-foreground'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {mode === 'new' && onPlace && (
        <button
          onClick={() => onPlace(p)}
          disabled={!canCommit}
          className="w-full rounded-xl bg-primary px-3 py-2.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {canCommit ? 'Place on artboard' : 'Loading font…'}
        </button>
      )}
      {mode === 'edit' && onUpdate && (
        <button
          onClick={() => onUpdate(p)}
          disabled={!canCommit}
          className="w-full rounded-xl bg-primary px-3 py-2.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {canCommit ? 'Apply changes' : 'Loading font…'}
        </button>
      )}
    </div>
  )
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
