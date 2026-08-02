import { describe, expect, it } from 'vitest'
import { DocumentSchema, PageSchema, type Page, type ScanDocument } from './types'
import { cappedCropSize, mapPerspectivePoint, orderQuad, perspectiveTransform, validCropQuad } from './services/image'
import { pageSizeFor } from './services/export'
import { orderedDocumentPages } from './services/storage'

describe('LocalScan manifest validation', () => {
  it('accepts a persisted document and page', () => {
    const document = DocumentSchema.parse({ id: 'doc-1', title: 'Receipt', createdAt: '2025-01-01', updatedAt: '2025-01-01', pageIds: ['page-1'], favorite: false, tags: [], ocrStatus: 'none', defaultPageSize: 'a4', lastOpenedAt: '2025-01-01' })
    const page = PageSchema.parse({ id: 'page-1', documentId: document.id, order: 0, createdAt: '2025-01-01', updatedAt: '2025-01-01', originalPath: 'original', source: 'image-import', width: 1200, height: 1600, mimeType: 'image/jpeg', rotation: 0, filter: 'document', processingStatus: 'ready', ocrStatus: 'not-requested', ocrLanguageCodes: ['eng'] })
    expect(page.documentId).toBe(document.id)
  })

  it('rejects a page with an invalid rotation', () => {
    expect(() => PageSchema.parse({ id: 'page-1', documentId: 'doc-1', order: 0, createdAt: '2025-01-01', updatedAt: '2025-01-01', originalPath: 'original', source: 'camera', width: 1200, height: 1600, mimeType: 'image/jpeg', rotation: 45, filter: 'document', processingStatus: 'ready', ocrStatus: 'not-requested', ocrLanguageCodes: [] })).toThrow()
  })

  it('accepts a rotated perspective crop inside an image', () => {
    expect(validCropQuad([{ x: 120, y: 80 }, { x: 1080, y: 120 }, { x: 1110, y: 1500 }, { x: 90, y: 1460 }], 1200, 1600)).toBe(true)
  })

  it('rejects a self-intersecting or out-of-bounds crop', () => {
    expect(validCropQuad([{ x: -2, y: 10 }, { x: 1100, y: 10 }, { x: 20, y: 1000 }, { x: 1000, y: 900 }], 1200, 1200)).toBe(false)
  })

  it('orders shuffled corners without duplicate-corner ambiguity', () => {
    expect(orderQuad([{ x: 1000, y: 900 }, { x: 80, y: 900 }, { x: 980, y: 100 }, { x: 120, y: 80 }])).toEqual([
      { x: 120, y: 80 }, { x: 980, y: 100 }, { x: 1000, y: 900 }, { x: 80, y: 900 },
    ])
    expect(orderQuad([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 100 }])).toBeUndefined()
  })

  it('maps every output edge to the detected camera frame, including rotated quads', () => {
    const cameraQuad = orderQuad([
      { x: 735, y: 215 }, { x: 1010, y: 1010 }, { x: 175, y: 875 }, { x: 380, y: 110 },
    ])
    expect(cameraQuad).toBeDefined()
    const transform = perspectiveTransform(cameraQuad!, 840, 1120)
    expect(transform).toBeDefined()
    const mappedCorners = [
      mapPerspectivePoint(transform!, 0, 0),
      mapPerspectivePoint(transform!, 839, 0),
      mapPerspectivePoint(transform!, 839, 1119),
      mapPerspectivePoint(transform!, 0, 1119),
    ]
    mappedCorners.forEach((point, index) => {
      expect(point!.x).toBeCloseTo(cameraQuad![index].x, 5)
      expect(point!.y).toBeCloseTo(cameraQuad![index].y, 5)
    })
  })

  it('caps perspective output allocation while preserving its ratio', () => {
    const size = cappedCropSize(12000, 9000)
    expect(size).toBeDefined()
    expect(size!.width).toBeLessThanOrEqual(4096)
    expect(size!.width * size!.height).toBeLessThanOrEqual(12_000_000)
    expect(size!.width / size!.height).toBeCloseTo(4 / 3, 2)
  })

  it('uses the selected PDF page size and keeps original scan aspect ratio', () => {
    const page = { width: 1600, height: 1000 } as Page
    expect(pageSizeFor(page, 'letter')).toEqual({ width: 612, height: 792 })
    const original = pageSizeFor(page, 'original')
    expect(original.width / original.height).toBeCloseTo(1.6, 2)
  })

  it('treats the document page list as authoritative over stale stored pages', () => {
    const document = { pageIds: ['second', 'first'] } as ScanDocument
    const first = { id: 'first', order: 0 } as Page
    const second = { id: 'second', order: 1 } as Page
    const stale = { id: 'deleted', order: 2 } as Page
    expect(orderedDocumentPages(document, [first, stale, second]).map(page => page.id)).toEqual(['second', 'first'])
  })
})
