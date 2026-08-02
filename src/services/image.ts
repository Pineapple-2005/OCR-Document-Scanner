import type { Filter } from '../types'
export async function processImage(file: Blob, filter: Filter, rotation: number): Promise<Blob> {
  const bitmap=await createImageBitmap(file); const canvas=document.createElement('canvas'); const turned=rotation===90||rotation===270
  canvas.width=turned?bitmap.height:bitmap.width; canvas.height=turned?bitmap.width:bitmap.height; const c=canvas.getContext('2d')!; c.save(); c.translate(canvas.width/2,canvas.height/2); c.rotate(rotation*Math.PI/180); c.drawImage(bitmap,-bitmap.width/2,-bitmap.height/2); c.restore();
  if(filter!=='original') { const data=c.getImageData(0,0,canvas.width,canvas.height); const p=data.data; for(let i=0;i<p.length;i+=4){ const l=.2126*p[i]+.7152*p[i+1]+.0722*p[i+2]; if(filter==='monotone'||filter==='black-white'){const v=Math.min(255,Math.max(0,(l-112)*1.65+112));p[i]=p[i+1]=p[i+2]=v}else if(filter==='enhance'||filter==='document'){const contrast=1.18; p[i]=Math.min(255,Math.max(0,(p[i]-128)*contrast+128));p[i+1]=Math.min(255,Math.max(0,(p[i+1]-128)*contrast+128));p[i+2]=Math.min(255,Math.max(0,(p[i+2]-128)*contrast+128))}else if(filter==='receipt'){const v=Math.min(255,Math.max(0,(l-100)*2.35+100));p[i]=p[i+1]=p[i+2]=v}else {p[i]=Math.min(255,p[i]*1.1);p[i+1]=Math.min(255,p[i+1]*1.12);p[i+2]=Math.min(255,p[i+2]*1.05)}} c.putImageData(data,0,0) }
  bitmap.close(); return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Image encoding failed')),'image/jpeg',.94))
}
export async function imageDimensions(file:Blob){const b=await createImageBitmap(file);const r={width:b.width,height:b.height};b.close();return r}
export type Point = { x: number; y: number }
export type Quad = [Point, Point, Point, Point]

/** Return corners in the only order accepted by the homography: TL, TR, BR, BL. */
export function orderQuad(points: Point[]): Quad | undefined {
  if (points.length !== 4 || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return undefined
  let tl = points[0]
  let tr = points[0]
  let br = points[0]
  let bl = points[0]
  let minSum = Infinity
  let maxSum = -Infinity
  let minDiff = Infinity
  let maxDiff = -Infinity
  for (const point of points) {
    const sum = point.x + point.y
    const diff = point.x - point.y
    if (sum < minSum) { minSum = sum; tl = point }
    if (sum > maxSum) { maxSum = sum; br = point }
    if (diff > maxDiff) { maxDiff = diff; tr = point }
    if (diff < minDiff) { minDiff = diff; bl = point }
  }
  const quad: Quad = [tl, tr, br, bl]
  const area = Math.abs(quad.reduce((sum, point, index) => {
    const next = quad[(index + 1) % quad.length]
    return sum + point.x * next.y - next.x * point.y
  }, 0)) / 2
  return area > 4 ? quad : undefined
}

/** Reject noisy/default detector output before attempting a destructive crop. */
export function validQuad(points: Point[], width: number, height: number) {
  const quad = orderQuad(points)
  if (!quad || width < 2 || height < 2) return false
  const area = Math.abs(quad.reduce((sum, point, index) => {
    const next = quad[(index + 1) % quad.length]
    return sum + point.x * next.y - next.x * point.y
  }, 0)) / 2
  const edgeLengths = quad.map((point, index) => {
    const next = quad[(index + 1) % quad.length]
    return Math.hypot(next.x - point.x, next.y - point.y)
  })
  return area > width * height * .08 && edgeLengths.every(length => length > Math.min(width, height) * .04)
}
/**
 * Validation for a user-edited crop. Manual crops are allowed to be tighter
 * than the camera detector's safety threshold, but still must be a real,
 * non-degenerate quadrilateral inside the source image.
 */
export function validCropQuad(points: Point[], width: number, height: number) {
  const quad = orderQuad(points)
  if (!quad || width < 2 || height < 2) return false
  const area = Math.abs(quad.reduce((sum, point, index) => {
    const next = quad[(index + 1) % quad.length]
    return sum + point.x * next.y - next.x * point.y
  }, 0)) / 2
  const edgeLengths = quad.map((point, index) => {
    const next = quad[(index + 1) % quad.length]
    return Math.hypot(next.x - point.x, next.y - point.y)
  })
  const inBounds = quad.every(point => point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height)
  return inBounds && area > width * height * .012 && edgeLengths.every(length => length > Math.min(width, height) * .01)
}
function homography(source: Point[], width: number, height: number) { const rows: number[][] = []; const values: number[] = []; const target = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }]; for (let i = 0; i < 4; i++) { const { x, y } = target[i]; const { x: u, y: v } = source[i]; rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); values.push(u); rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]); values.push(v) } for (let i = 0; i < 8; i++) { let pivot = i; for (let row = i + 1; row < 8; row++) if (Math.abs(rows[row][i]) > Math.abs(rows[pivot][i])) pivot = row; [rows[i], rows[pivot]] = [rows[pivot], rows[i]]; [values[i], values[pivot]] = [values[pivot], values[i]]; const divisor = rows[i][i] || 1; for (let col = i; col < 8; col++) rows[i][col] /= divisor; values[i] /= divisor; for (let row = 0; row < 8; row++) if (row !== i) { const factor = rows[row][i]; for (let col = i; col < 8; col++) rows[row][col] -= factor * rows[i][col]; values[row] -= factor * values[i] } } return [...values, 1] }
export async function perspectiveCrop(file: Blob, corners: Point[]) {
  const bitmap = await createImageBitmap(file)
  const quad = orderQuad(corners)
  if (!quad || !validCropQuad(quad, bitmap.width, bitmap.height)) {
    bitmap.close()
    return file
  }
  const sourceCanvas = document.createElement('canvas')
  sourceCanvas.width = bitmap.width
  sourceCanvas.height = bitmap.height
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true })!
  sourceContext.drawImage(bitmap, 0, 0)
  const source = sourceContext.getImageData(0, 0, bitmap.width, bitmap.height)
  const topWidth = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y)
  const bottomWidth = Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y)
  const leftHeight = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y)
  const rightHeight = Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y)
  const outputWidth = Math.max(1, Math.round(Math.max(topWidth, bottomWidth)))
  const outputHeight = Math.max(1, Math.round(Math.max(leftHeight, rightHeight)))
  const h = homography(quad, outputWidth, outputHeight)
  const output = new ImageData(outputWidth, outputHeight)
  for (let y = 0; y < outputHeight; y++) for (let x = 0; x < outputWidth; x++) {
    const denominator = h[6] * x + h[7] * y + 1
    const sourceX = clamp((h[0] * x + h[1] * y + h[2]) / denominator, 0, bitmap.width - 1)
    const sourceY = clamp((h[3] * x + h[4] * y + h[5]) / denominator, 0, bitmap.height - 1)
    // Bilinear sampling prevents jagged text at the document edges while
    // retaining a dependency-free local cropper.
    const x0 = Math.floor(sourceX); const y0 = Math.floor(sourceY)
    const x1 = Math.min(bitmap.width - 1, x0 + 1); const y1 = Math.min(bitmap.height - 1, y0 + 1)
    const fx = sourceX - x0; const fy = sourceY - y0
    const to = (y * outputWidth + x) * 4
    for (let channel = 0; channel < 3; channel++) {
      const top = source.data[(y0 * bitmap.width + x0) * 4 + channel] * (1 - fx) + source.data[(y0 * bitmap.width + x1) * 4 + channel] * fx
      const bottom = source.data[(y1 * bitmap.width + x0) * 4 + channel] * (1 - fx) + source.data[(y1 * bitmap.width + x1) * 4 + channel] * fx
      output.data[to + channel] = top * (1 - fy) + bottom * fy
    }
    output.data[to + 3] = 255
  }
  const canvas = document.createElement('canvas')
  canvas.width = outputWidth
  canvas.height = outputHeight
  canvas.getContext('2d')!.putImageData(output, 0, 0)
  bitmap.close()
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Perspective correction failed')), 'image/jpeg', .95))
}
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)) }
export async function cropImage(file: Blob, inset = .08) { const image = await createImageBitmap(file); const left = Math.round(image.width * inset); const top = Math.round(image.height * inset); const canvas = document.createElement('canvas'); canvas.width = image.width - left * 2; canvas.height = image.height - top * 2; canvas.getContext('2d')!.drawImage(image, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height); image.close(); return new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Crop failed')), 'image/jpeg', .95)) }
export function download(blob:Blob,name:string){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
