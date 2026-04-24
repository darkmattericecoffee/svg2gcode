import html2canvas from 'html2canvas-pro'
import jsPDF from 'jspdf'

interface ExportOptions {
  filename: string
}

// A4 in mm, portrait.
const A4_WIDTH_MM = 210
const A4_HEIGHT_MM = 297
const PAGE_MARGIN_MM = 10

export async function exportPreparePdf(rootEl: HTMLElement, { filename }: ExportOptions): Promise<void> {
  const canvas = await html2canvas(rootEl, {
    scale: 2,
    backgroundColor: '#ffffff',
    useCORS: true,
    logging: false,
  })

  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })

  const usableW = A4_WIDTH_MM - PAGE_MARGIN_MM * 2
  const usableH = A4_HEIGHT_MM - PAGE_MARGIN_MM * 2

  const pxPerMm = canvas.width / usableW
  const pageHeightPx = Math.floor(usableH * pxPerMm)

  const pageCanvas = document.createElement('canvas')
  pageCanvas.width = canvas.width
  const ctx = pageCanvas.getContext('2d')!

  let consumed = 0
  let pageIndex = 0
  while (consumed < canvas.height) {
    const remaining = canvas.height - consumed
    const sliceHeight = Math.min(pageHeightPx, remaining)
    pageCanvas.height = sliceHeight
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
    ctx.drawImage(
      canvas,
      0,
      consumed,
      canvas.width,
      sliceHeight,
      0,
      0,
      canvas.width,
      sliceHeight,
    )

    const imgData = pageCanvas.toDataURL('image/jpeg', 0.92)
    const sliceHeightMm = sliceHeight / pxPerMm
    if (pageIndex > 0) pdf.addPage()
    pdf.addImage(
      imgData,
      'JPEG',
      PAGE_MARGIN_MM,
      PAGE_MARGIN_MM,
      usableW,
      sliceHeightMm,
      undefined,
      'FAST',
    )

    consumed += sliceHeight
    pageIndex += 1
  }

  pdf.save(filename)
}
