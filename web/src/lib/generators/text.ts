import type { TextParams } from '../../types/editor'
import { getCachedFont } from '../fonts/googleFonts'

const PT_TO_MM = 25.4 / 72

/**
 * Produces an SVG whose coordinate units are mm, containing the
 * text outlined as path data. The font must already be present in the
 * googleFonts cache (the form is responsible for preloading it).
 */
export function generateText(params: TextParams): string {
  const sizeMm = Math.max(0.1, params.fontSizePt * PT_TO_MM)
  const lineHeightMm = sizeMm * Math.max(0.5, params.lineHeight)
  const text = params.text.length > 0 ? params.text : ' '

  const font = getCachedFont(params.fontFamily, params.fontVariant)
  if (!font) {
    return placeholderSvg(sizeMm, text)
  }
  if (text.trim().length === 0) {
    return placeholderSvg(sizeMm, text)
  }

  const ascMm = (font.ascender / font.unitsPerEm) * sizeMm
  const descMm = (font.descender / font.unitsPerEm) * sizeMm // negative

  const lines = text.split(/\r?\n/)
  const lineWidths = lines.map((line) => font.getAdvanceWidth(line || ' ', sizeMm))
  const maxWidth = Math.max(0.1, ...lineWidths)
  const totalHeight = Math.max(
    0.1,
    ascMm - descMm + Math.max(0, lines.length - 1) * lineHeightMm,
  )

  const pieces: string[] = []
  lines.forEach((line, idx) => {
    const lineWidth = lineWidths[idx]
    let x = 0
    if (params.align === 'middle') x = (maxWidth - lineWidth) / 2
    else if (params.align === 'end') x = maxWidth - lineWidth
    const y = ascMm + idx * lineHeightMm
    if (!line) return
    const path = font.getPath(line, x, y, sizeMm)
    pieces.push(path.toPathData(3))
  })

  const d = pieces.join(' ')
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${maxWidth}" height="${totalHeight}" viewBox="0 0 ${maxWidth} ${totalHeight}">`,
    `<path d="${d}" fill="#000" stroke="#000" stroke-width="0.1" fill-rule="evenodd" />`,
    `</svg>`,
  ].join('')
}

function placeholderSvg(sizeMm: number, text: string): string {
  const w = Math.max(5, text.length * sizeMm * 0.5)
  const h = Math.max(3, sizeMm * 1.2)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect x="0" y="0" width="${w}" height="${h}" fill="none" stroke="#888" stroke-dasharray="0.5,0.5" stroke-width="0.2" />`,
    `</svg>`,
  ].join('')
}
