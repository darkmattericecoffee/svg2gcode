import Konva from 'konva'
import type { CSSProperties } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useEditorStore } from '../store'
import type { GroupNode, TextParams } from '../types/editor'

const PT_TO_MM = 25.4 / 72

/**
 * In-canvas text editor. Mounts an absolutely-positioned HTML textarea over
 * the Konva stage, sized/placed so that its glyphs align with the underlying
 * baked paths (same TTF via registerFontFace + matching units).
 */
export function TextEditOverlay() {
  const editingId = useEditorStore((s) => s.ui.editingTextNodeId)
  const viewport = useEditorStore((s) => s.viewport)
  const nodesById = useEditorStore((s) => s.nodesById)
  const stopEditingText = useEditorStore((s) => s.stopEditingText)
  const updateGeneratorParams = useEditorStore((s) => s.updateGeneratorParams)

  const node = editingId ? (nodesById[editingId] as GroupNode | undefined) : undefined
  const params =
    node && node.generatorMetadata?.params.kind === 'text'
      ? (node.generatorMetadata.params as TextParams)
      : null

  const [draft, setDraft] = useState(params?.text ?? '')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const paramsRef = useRef<TextParams | null>(params)
  paramsRef.current = params

  // Reset draft when target changes
  useEffect(() => {
    if (params) setDraft(params.text)
  }, [editingId, params])

  // Focus on mount and select all
  useLayoutEffect(() => {
    if (!editingId) return
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [editingId])

  // Debounced push to store
  useEffect(() => {
    if (!editingId || !paramsRef.current) return
    if (draft === paramsRef.current.text) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const current = paramsRef.current
      if (!current) return
      updateGeneratorParams(editingId, { ...current, text: draft })
    }, 150)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [draft, editingId, updateGeneratorParams])

  const style = useMemo(() => {
    if (!node || !params || !editingId) return null
    const stage = Konva.stages[0]
    if (!stage) return null
    const konvaNode = stage.findOne('#' + editingId)
    if (!konvaNode) return null
    const abs = konvaNode.getAbsolutePosition()
    const sizeMm = params.fontSizePt * PT_TO_MM
    const fontSizePx = sizeMm * viewport.scale
    const textAlign: CSSProperties['textAlign'] =
      params.align === 'middle' ? 'center' : params.align === 'end' ? 'right' : 'left'
    return {
      left: abs.x,
      top: abs.y,
      fontSizePx,
      fontFamily: params.fontFamily,
      textAlign,
      lineHeight: params.lineHeight,
    }
  }, [node, params, editingId, viewport.x, viewport.y, viewport.scale])

  if (!editingId || !node || !params || !style) return null

  return (
    <textarea
      ref={textareaRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        // Flush immediately then exit
        if (debounceRef.current) clearTimeout(debounceRef.current)
        if (paramsRef.current && draft !== paramsRef.current.text) {
          updateGeneratorParams(editingId, { ...paramsRef.current, text: draft })
        }
        stopEditingText()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          stopEditingText()
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          stopEditingText()
        }
        e.stopPropagation()
      }}
      spellCheck={false}
      className="absolute z-30 resize-none overflow-hidden whitespace-pre bg-transparent p-0 text-black caret-primary outline-none"
      style={{
        left: `${style.left}px`,
        top: `${style.top}px`,
        fontSize: `${style.fontSizePx}px`,
        fontFamily: `"${style.fontFamily}", sans-serif`,
        fontWeight: extractWeight(params.fontVariant),
        fontStyle: /italic/i.test(params.fontVariant) ? 'italic' : 'normal',
        lineHeight: style.lineHeight,
        textAlign: style.textAlign,
        color: 'rgba(0,0,0,0.9)',
        minWidth: '40px',
        minHeight: `${style.fontSizePx * style.lineHeight}px`,
        border: '1px dashed rgba(56,132,255,0.8)',
      }}
    />
  )
}

function extractWeight(variant: string): number {
  const match = variant.match(/\d+/)
  const weight = match ? Number(match[0]) : 400
  return weight || 400
}
