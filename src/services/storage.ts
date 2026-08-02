import { DocumentSchema, PageSchema, type LibraryItem, type Page, type ScanDocument } from '../types'

const ROOT = 'localscan'
type FallbackRecord = { key: string; value: unknown; blob?: Blob }
const DB_NAME = 'localscan-fallback'
function fallbackDb() { return new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(DB_NAME, 1); request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'key' }); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) }) }
async function fallbackPut(record: FallbackRecord) { const db = await fallbackDb(); await new Promise<void>((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put(record); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) }) }
async function fallbackGet(key: string) { const db = await fallbackDb(); return new Promise<FallbackRecord | undefined>((resolve, reject) => { const tx = db.transaction('records'); const request = tx.objectStore('records').get(key); request.onsuccess = () => resolve(request.result as FallbackRecord | undefined); request.onerror = () => reject(request.error) }) }
async function fallbackAll() { const db = await fallbackDb(); return new Promise<FallbackRecord[]>((resolve, reject) => { const tx = db.transaction('records'); const request = tx.objectStore('records').getAll(); request.onsuccess = () => resolve(request.result as FallbackRecord[]); request.onerror = () => reject(request.error) }) }
async function root() { return (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true }) }
async function dir(handle: FileSystemDirectoryHandle, name: string) { return handle.getDirectoryHandle(name, { create: true }) }
async function write(handle: FileSystemDirectoryHandle, name: string, data: Blob | string) { const file = await handle.getFileHandle(name, { create: true }); const writer = await file.createWritable(); await writer.write(data); await writer.close() }
async function read(handle: FileSystemDirectoryHandle, name: string) { return (await (await handle.getFileHandle(name)).getFile()).text() }

export const storage = {
  supported: () => typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function',
  mode: () => {
    if (typeof navigator === 'undefined') return 'Browser-managed local storage'
    return typeof navigator.storage?.getDirectory === 'function' ? 'Browser-managed local storage (OPFS)' : 'Browser-managed local storage (IndexedDB)'
  },
  async list(): Promise<LibraryItem[]> {
    if (!this.supported()) { const all = await fallbackAll(); const docs = all.filter(x => x.key.startsWith('doc:')).map(x => DocumentSchema.parse(x.value)); return docs.map(document => ({ document, pages: all.filter(x => x.key.startsWith(`page:${document.id}:`)).map(x => PageSchema.parse(x.value)).sort((a, b) => a.order - b.order) })).sort((a, b) => b.document.updatedAt.localeCompare(a.document.updatedAt)) }
    const r = await root(); const docs = await dir(r, 'documents'); const values: LibraryItem[] = []
    for await (const [_id, handle] of docs.entries()) { if (handle.kind !== 'directory') continue; try { const document = DocumentSchema.parse(JSON.parse(await read(handle, 'manifest.json'))); const pagesDir = await dir(handle, 'pages'); const pages: Page[] = []; for await (const [, pageHandle] of pagesDir.entries()) if (pageHandle.kind === 'directory') pages.push(PageSchema.parse(JSON.parse(await read(pageHandle, 'manifest.json')))); values.push({ document, pages: pages.sort((a, b) => a.order - b.order) }) } catch { /* isolate corrupted records */ } }
    return values.sort((a, b) => b.document.updatedAt.localeCompare(a.document.updatedAt))
  },
  async saveDocument(document: ScanDocument) { if (!this.supported()) { await fallbackPut({ key: `doc:${document.id}`, value: document }); return } const r = await root(); const handle = await dir(await dir(r, 'documents'), document.id); await write(handle, 'manifest.next.json', JSON.stringify(document)); await write(handle, 'manifest.json', JSON.stringify(document)) },
  async savePage(page: Page, original?: Blob, processed?: Blob) { if (!this.supported()) { await fallbackPut({ key: `page:${page.documentId}:${page.id}`, value: page }); if (original) await fallbackPut({ key: `original:${page.documentId}:${page.id}`, value: null, blob: original }); if (processed) await fallbackPut({ key: `processed:${page.documentId}:${page.id}`, value: null, blob: processed }); return } const r = await root(); const pagesDir = await dir(await dir(await dir(r, 'documents'), page.documentId), 'pages'); const handle = await dir(pagesDir, page.id); if (original) await write(handle, 'original', original); if (processed) await write(handle, 'processed', processed); await write(handle, 'manifest.next.json', JSON.stringify(page)); await write(handle, 'manifest.json', JSON.stringify(page)) },
  async blob(page: Page, processed = true) { if (!this.supported()) { const record = await fallbackGet(`${processed && page.processedPath ? 'processed' : 'original'}:${page.documentId}:${page.id}`); if (!record?.blob) throw new Error('Stored page image is missing'); return record.blob } const r = await root(); const handle = await dir(await dir(await dir(await dir(r, 'documents'), page.documentId), 'pages'), page.id); return (await handle.getFileHandle(processed && page.processedPath ? 'processed' : 'original')).getFile() },
  async remove(id: string) { if (!this.supported()) { const db = await fallbackDb(); const all = await fallbackAll(); for (const record of all.filter(x => x.key === `doc:${id}` || x.key.includes(`:${id}:`))) await new Promise<void>((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').delete(record.key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) }); return } const r = await root(); await (await dir(r, 'documents')).removeEntry(id, { recursive: true }) },
  async clear() {
    if (!this.supported()) {
      const db = await fallbackDb()
      await new Promise<void>((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) })
      return
    }
    const r = await root(); const docs = await dir(r, 'documents'); const names: string[] = []
    for await (const [name] of docs.entries()) names.push(name)
    for (const name of names) await docs.removeEntry(name, { recursive: true })
  },
  async estimate() { return navigator.storage?.estimate?.() ?? {} },
  async persist() { return navigator.storage?.persist?.() ?? false }
}
