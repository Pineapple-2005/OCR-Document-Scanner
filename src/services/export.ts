import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import { Document, Packer, Paragraph, ImageRun } from 'docx'
import JSZip from 'jszip'
import type { Page, ScanDocument } from '../types'
import { storage } from './storage'
import { download } from './image'

const safe = (value: string) => value.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '') || 'scan'
type RasterKind = 'png' | 'jpeg' | 'webp'
type PageSize = { width: number; height: number }

const fixedPageSizes: Record<'a4' | 'letter' | 'legal', PageSize> = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
  legal: { width: 612, height: 1008 },
}

/** The original option keeps the scan aspect ratio without creating huge PDFs. */
export function pageSizeFor(page: Page, selected: ScanDocument['defaultPageSize']): PageSize {
  if (selected !== 'original') return fixedPageSizes[selected]
  const aspect = Math.max(.05, Math.min(20, page.width / page.height))
  const longEdge = 842
  return aspect >= 1
    ? { width: longEdge, height: Math.max(72, longEdge / aspect) }
    : { width: Math.max(72, longEdge * aspect), height: longEdge }
}

function mimeFor(kind: RasterKind) { return kind === 'png' ? 'image/png' : kind === 'webp' ? 'image/webp' : 'image/jpeg' }
function extensionForMime(mime: string) {
  if (mime.includes('png')) return 'png'
  if (mime.includes('webp')) return 'webp'
  return 'jpg'
}

function canvasBlob(canvas: HTMLCanvasElement, mime: string, quality = .94) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The image could not be encoded for export.')), mime, quality))
}

async function rasterize(blob: Blob, kind: RasterKind) {
  const image = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Your browser could not prepare this image for export.')
    context.drawImage(image, 0, 0)
    return await canvasBlob(canvas, mimeFor(kind))
  } finally { image.close() }
}

async function pdfImage(pdf: PDFDocument, blob: Blob) {
  const bytes = await blob.arrayBuffer()
  if (blob.type.toLowerCase().includes('png')) return pdf.embedPng(bytes)
  if (blob.type.toLowerCase().includes('jpeg') || blob.type.toLowerCase().includes('jpg')) return pdf.embedJpg(bytes)
  const jpeg = await rasterize(blob, 'jpeg')
  return pdf.embedJpg(await jpeg.arrayBuffer())
}

export async function buildPdf(scanDocument: ScanDocument, pages: Page[], kind: 'pdf' | 'searchable' | 'text-pdf' = 'pdf') {
  if (!pages.length) throw new Error('Add at least one page before exporting.')
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const pageData of pages) {
    const size = pageSizeFor(pageData, scanDocument.defaultPageSize)
    const page = pdf.addPage([size.width, size.height])
    if (kind !== 'text-pdf') {
      const image = await pdfImage(pdf, await storage.blob(pageData))
      const margin = 20
      const scale = Math.min((size.width - margin * 2) / image.width, (size.height - margin * 2) / image.height)
      page.drawImage(image, { x: (size.width - image.width * scale) / 2, y: (size.height - image.height * scale) / 2, width: image.width * scale, height: image.height * scale })
    }
    if (pageData.text) {
      page.drawText(pageData.text.slice(0, 9000), {
        x: 20,
        y: kind === 'text-pdf' ? size.height - 32 : 20,
        size: kind === 'text-pdf' ? 11 : 1,
        color: kind === 'text-pdf' ? rgb(.1, .1, .1) : rgb(1, 1, 1),
        font,
        maxWidth: size.width - 40,
        lineHeight: 14,
      })
    }
  }
  const bytes = await pdf.save()
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' })
}

async function buildDocx(pages: Page[], editable: boolean) {
  if (!pages.length) throw new Error('Add at least one page before exporting.')
  const children: Paragraph[] = []
  for (const page of pages) {
    if (editable && page.text) {
      children.push(new Paragraph(page.text))
      continue
    }
    const source = await storage.blob(page)
    const image = source.type.toLowerCase().includes('png') ? source : await rasterize(source, 'jpeg')
    children.push(new Paragraph({ children: [new ImageRun({
      type: image.type.includes('png') ? 'png' : 'jpg',
      data: new Uint8Array(await image.arrayBuffer()),
      transformation: { width: 520, height: Math.min(700, 520 * page.height / page.width) },
    })] }))
  }
  return Packer.toBlob(new Document({ sections: [{ children }] }))
}

async function exportRasterPages(name: string, pages: Page[], kind: RasterKind) {
  if (!pages.length) throw new Error('Add at least one page before exporting.')
  const extension = kind === 'jpeg' ? 'jpg' : kind
  const rendered = await Promise.all(pages.map(async page => ({ page, blob: await rasterize(await storage.blob(page), kind) })))
  if (rendered.length === 1) {
    download(rendered[0].blob, `${name}.${extension}`)
    return
  }
  const zip = new JSZip()
  for (let index = 0; index < rendered.length; index++) zip.file(`${name}-${index + 1}.${extension}`, rendered[index].blob)
  download(await zip.generateAsync({ type: 'blob' }), `${name}-${extension}-pages.zip`)
}

async function exportOriginalPages(name: string, pages: Page[]) {
  if (!pages.length) throw new Error('Add at least one page before exporting.')
  const zip = new JSZip()
  for (let index = 0; index < pages.length; index++) {
    const blob = await storage.blob(pages[index])
    zip.file(`${name}-${index + 1}.${extensionForMime(blob.type)}`, blob)
  }
  download(await zip.generateAsync({ type: 'blob' }), `${name}-pages.zip`)
}

export async function exportFile(scanDocument: ScanDocument, pages: Page[], kind: string) {
  const name = safe(scanDocument.title)
  if (kind === 'pdf' || kind === 'searchable' || kind === 'text-pdf') {
    download(await buildPdf(scanDocument, pages, kind), `${name}.pdf`)
    return
  }
  if (kind === 'docx' || kind === 'editable-docx') {
    download(await buildDocx(pages, kind === 'editable-docx'), `${name}.docx`)
    return
  }
  if (kind === 'zip') {
    await exportOriginalPages(name, pages)
    return
  }
  if (kind === 'png' || kind === 'jpeg' || kind === 'webp') {
    await exportRasterPages(name, pages, kind)
    return
  }
  throw new Error('Choose a supported export format.')
}
