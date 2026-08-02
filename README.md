# LocalScan

LocalScan is a local-first document scanner PWA. Documents, processing, OCR text, and exports are generated in the browser; no account, backend, analytics, or document upload is used. Live camera scanning is intentionally mobile-first; larger screens can import images and use the full editing/export/print workflow.

## Commands

`npm install` · `npm run dev` · `npm run typecheck` · `npm run lint` · `npm run test` · `npm run build`

## Architecture

- `src/services/storage.ts` persists validated document/page manifests and original/processed image blobs in OPFS.
- `src/services/image.ts` applies non-destructive perspective correction, canvas filters, cropping, and rotation from the original capture.
- `src/workers/cv.worker.ts` analyzes reduced camera frames locally, scores a document candidate, orders four corners, and drives the live outline. Capture remains user-controlled.
- `src/services/ocr.ts` runs Tesseract in-browser.
- `src/services/export.ts` produces PDF, DOCX, image, and ZIP downloads locally.
- `src/App.tsx` owns accessible routes for library, scanner, editor, OCR, export, print, settings, storage, and help.

## Browser notes

Use HTTPS for camera and installability. Camera hardware, File System Access, persistent storage, and the system print dialog are browser-controlled. Browser security prevents silent printing or automatic printer selection. OCR language data is fetched and then browser-cached by Tesseract on its first use; for completely air-gapped deployments, serve the trained-data assets with this static application and configure Tesseract paths accordingly.

## Storage and privacy

OPFS stores binaries and JSON manifests under `localscan/documents`. Clearing site data can remove them; export important documents for backup. The service worker caches only application shell assets, never scanned documents.

## Deployment

Run `npm run build` and host `dist/` with HTTPS on Vercel, Netlify, Cloudflare Pages, or another static host configured to return `index.html` for application routes.
