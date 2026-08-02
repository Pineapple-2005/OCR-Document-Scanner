import { describe, expect, it } from 'vitest'
import { DocumentSchema, PageSchema } from './types'

describe('LocalScan manifest validation', () => {
  it('accepts a persisted document and page', () => {
    const document = DocumentSchema.parse({ id: 'doc-1', title: 'Receipt', createdAt: '2025-01-01', updatedAt: '2025-01-01', pageIds: ['page-1'], favorite: false, tags: [], ocrStatus: 'none', defaultPageSize: 'a4', lastOpenedAt: '2025-01-01' })
    const page = PageSchema.parse({ id: 'page-1', documentId: document.id, order: 0, createdAt: '2025-01-01', updatedAt: '2025-01-01', originalPath: 'original', source: 'image-import', width: 1200, height: 1600, mimeType: 'image/jpeg', rotation: 0, filter: 'document', processingStatus: 'ready', ocrStatus: 'not-requested', ocrLanguageCodes: ['eng'] })
    expect(page.documentId).toBe(document.id)
  })

  it('rejects a page with an invalid rotation', () => {
    expect(() => PageSchema.parse({ id: 'page-1', documentId: 'doc-1', order: 0, createdAt: '2025-01-01', updatedAt: '2025-01-01', originalPath: 'original', source: 'camera', width: 1200, height: 1600, mimeType: 'image/jpeg', rotation: 45, filter: 'document', processingStatus: 'ready', ocrStatus: 'not-requested', ocrLanguageCodes: [] })).toThrow()
  })
})
