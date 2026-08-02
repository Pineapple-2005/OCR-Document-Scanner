import { z } from 'zod'

export const FilterSchema = z.enum(['original', 'document', 'black-white', 'receipt', 'whiteboard'])
export type Filter = z.infer<typeof FilterSchema>
export const OcrStatusSchema = z.enum(['not-requested', 'queued', 'processing', 'complete', 'low-confidence', 'failed', 'cancelled'])
export type OcrStatus = z.infer<typeof OcrStatusSchema>
export const PageSchema = z.object({
  id: z.string(), documentId: z.string(), order: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string(),
  originalPath: z.string(), processedPath: z.string().optional(), thumbnailPath: z.string().optional(), ocrPath: z.string().optional(),
  source: z.enum(['camera', 'image-import']), width: z.number().positive(), height: z.number().positive(), mimeType: z.string(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]), filter: FilterSchema,
  processingStatus: z.enum(['captured', 'ready', 'failed']), ocrStatus: OcrStatusSchema, ocrLanguageCodes: z.array(z.string()),
  ocrAverageConfidence: z.number().optional(), text: z.string().optional(), cropQuad: z.array(z.object({ x: z.number(), y: z.number() })).length(4).optional()
})
export type Page = z.infer<typeof PageSchema>
export const DocumentSchema = z.object({
  id: z.string(), title: z.string().min(1).max(120), createdAt: z.string(), updatedAt: z.string(), pageIds: z.array(z.string()),
  thumbnailPath: z.string().optional(), favorite: z.boolean(), tags: z.array(z.string()), ocrStatus: z.enum(['none','partial','complete']),
  defaultPageSize: z.enum(['original','a4','letter','legal']), lastOpenedAt: z.string()
})
export type ScanDocument = z.infer<typeof DocumentSchema>
export type LibraryItem = { document: ScanDocument; pages: Page[] }
