import type { Filter } from '../types'

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)))
const luminance = (red: number, green: number, blue: number) => .2126 * red + .7152 * green + .0722 * blue

/**
 * Improve a colour document without turning it into a grey scan.
 *
 * The previous implementation applied one fixed contrast value to every
 * channel. That made dark phone photos stay muddy and clipped highlights on
 * white paper. A percentile tone map is much more useful for scans: it
 * adapts to the actual exposure, then applies the same luminance gain to RGB
 * so ink and paper colour are retained.
 */
export function enhancePixels(data: Uint8ClampedArray, width: number, height: number) {
  const pixelCount = Math.max(0, width * height)
  if (!pixelCount || data.length < pixelCount * 4) return

  // Build a small luminance histogram. Sampling keeps a large phone frame
  // responsive while still seeing enough of the page to choose good limits.
  const histogram = new Uint32Array(256)
  const sampleStride = Math.max(1, Math.floor(Math.sqrt(pixelCount / 50000)))
  let samples = 0
  for (let y = 0; y < height; y += sampleStride) {
    for (let x = 0; x < width; x += sampleStride) {
      const index = (y * width + x) * 4
      histogram[Math.round(luminance(data[index], data[index + 1], data[index + 2]))]++
      samples++
    }
  }
  if (!samples) return

  const percentile = (fraction: number) => {
    const target = Math.max(0, Math.min(samples - 1, Math.round((samples - 1) * fraction)))
    let seen = 0
    for (let value = 0; value < histogram.length; value++) {
      seen += histogram[value]
      if (seen > target) return value
    }
    return 255
  }
  let black = percentile(.015)
  let white = percentile(.985)
  // A mostly-white page (or an evenly exposed blank page) can put both
  // percentiles at 255. Never map that valid paper white to black. With no
  // useful dynamic range, retain the source tones and only apply the gentle
  // gamma lift below instead of inventing contrast from a narrow sample.
  if (white - black < 48) {
    black = 0
    white = 255
  }
  white = Math.max(black + 24, white)
  const range = white - black

  for (let index = 0; index < pixelCount * 4; index += 4) {
    const red = data[index]
    const green = data[index + 1]
    const blue = data[index + 2]
    const sourceLuma = luminance(red, green, blue)
    const normalized = Math.max(0, Math.min(1, (sourceLuma - black) / range))
    // A very gentle gamma lift opens shadows while the percentile stretch
    // restores paper whites. Keeping this below 1 avoids a washed-out page.
    const targetLuma = Math.pow(normalized, .93) * 255
    const gain = Math.max(.5, Math.min(2.25, targetLuma / Math.max(sourceLuma, 12)))
    data[index] = clampByte(red * gain)
    data[index + 1] = clampByte(green * gain)
    data[index + 2] = clampByte(blue * gain)
  }
}

type MonotoneField = { width: number; height: number; values: Float32Array }

/** Build a low-resolution adaptive threshold field for page-aware B/W scans. */
function monotoneThresholdField(gray: Uint8Array, width: number, height: number): MonotoneField {
  const pixelCount = width * height
  const tileSize = Math.max(24, Math.min(96, Math.round(Math.sqrt(pixelCount / 4000))))
  const columns = Math.ceil(width / tileSize)
  const rows = Math.ceil(height / tileSize)
  const values = new Float32Array(columns * rows)
  let globalSum = 0
  for (let tileY = 0; tileY < rows; tileY++) {
    const top = tileY * tileSize
    const bottom = Math.min(height, top + tileSize)
    for (let tileX = 0; tileX < columns; tileX++) {
      const left = tileX * tileSize
      const right = Math.min(width, left + tileSize)
      let sum = 0
      let squareSum = 0
      let count = 0
      for (let y = top; y < bottom; y++) {
        const row = y * width
        for (let x = left; x < right; x++) {
          const value = gray[row + x]
          sum += value
          squareSum += value * value
          count++
        }
      }
      const mean = sum / Math.max(1, count)
      const variance = Math.max(0, squareSum / Math.max(1, count) - mean * mean)
      const standardDeviation = Math.sqrt(variance)
      // Sauvola-inspired threshold. It follows shadows on the page while
      // leaving high-contrast ink comfortably below the cut-off.
      values[tileY * columns + tileX] = Math.max(72, Math.min(224, mean * (1 + .24 * (standardDeviation / 128 - 1))))
      globalSum += sum
    }
  }
  // Blend every local tile with a small global component to avoid visible
  // seams where two tiles have very different backgrounds.
  const globalMean = globalSum / Math.max(1, pixelCount)
  for (let index = 0; index < values.length; index++) values[index] = values[index] * .78 + globalMean * .22
  return { width: columns, height: rows, values }
}

function interpolatedFieldValue(field: MonotoneField, x: number, y: number, tileSize: number) {
  const column = Math.max(0, Math.min(field.width - 1, x / tileSize - .5))
  const row = Math.max(0, Math.min(field.height - 1, y / tileSize - .5))
  const x0 = Math.floor(column)
  const y0 = Math.floor(row)
  const x1 = Math.min(field.width - 1, x0 + 1)
  const y1 = Math.min(field.height - 1, y0 + 1)
  const fx = column - x0
  const fy = row - y0
  const topLeft = field.values[y0 * field.width + x0]
  const topRight = field.values[y0 * field.width + x1]
  const bottomLeft = field.values[y1 * field.width + x0]
  const bottomRight = field.values[y1 * field.width + x1]
  return topLeft * (1 - fx) * (1 - fy) + topRight * fx * (1 - fy) + bottomLeft * (1 - fx) * fy + bottomRight * fx * fy
}

/**
 * Apply an adaptive, soft monochrome conversion.
 *
 * Unlike a single global threshold, the threshold follows page shadows and
 * uneven lighting. A soft transition preserves anti-aliased text edges so
 * the resulting JPEG remains legible when zoomed or OCR'd.
 */
export function monotonePixels(data: Uint8ClampedArray, width: number, height: number) {
  const pixelCount = Math.max(0, width * height)
  if (!pixelCount || data.length < pixelCount * 4) return
  const gray = new Uint8Array(pixelCount)
  for (let index = 0; index < pixelCount; index++) {
    const source = index * 4
    gray[index] = clampByte(luminance(data[source], data[source + 1], data[source + 2]))
  }
  const tileSize = Math.max(24, Math.min(96, Math.round(Math.sqrt(pixelCount / 4000))))
  const field = monotoneThresholdField(gray, width, height)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const threshold = interpolatedFieldValue(field, x, y, tileSize)
      // 42 gives a smooth but still decisive ink edge. Keep channels equal
      // so consumers can reliably identify this as a monochrome page.
      const value = clampByte((gray[row + x] - threshold) * 5.2 + 128)
      const target = (row + x) * 4
      data[target] = value
      data[target + 1] = value
      data[target + 2] = value
    }
  }
}

export async function processImage(file: Blob, filter: Filter, rotation: number): Promise<Blob> {
  const bitmap=await createImageBitmap(file); const canvas=document.createElement('canvas'); const turned=rotation===90||rotation===270
  canvas.width=turned?bitmap.height:bitmap.width; canvas.height=turned?bitmap.width:bitmap.height; const c=canvas.getContext('2d')!; c.save(); c.translate(canvas.width/2,canvas.height/2); c.rotate(rotation*Math.PI/180); c.drawImage(bitmap,-bitmap.width/2,-bitmap.height/2); c.restore();
  if(filter!=='original') { const data=c.getImageData(0,0,canvas.width,canvas.height); const p=data.data; if(filter==='enhance'||filter==='document') enhancePixels(p, canvas.width, canvas.height); else if(filter==='monotone'||filter==='black-white') monotonePixels(p, canvas.width, canvas.height); else for(let i=0;i<p.length;i+=4){ const l=luminance(p[i],p[i+1],p[i+2]); if(filter==='receipt'){const v=Math.min(255,Math.max(0,(l-100)*2.35+100));p[i]=p[i+1]=p[i+2]=v}else {p[i]=Math.min(255,p[i]*1.1);p[i+1]=Math.min(255,p[i+1]*1.12);p[i+2]=Math.min(255,p[i+2]*1.05)}} c.putImageData(data,0,0) }
  bitmap.close(); return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Image encoding failed')),'image/jpeg',.94))
}
export async function imageDimensions(file:Blob){const b=await createImageBitmap(file);const r={width:b.width,height:b.height};b.close();return r}
export type Point = { x: number; y: number }
export type Quad = [Point, Point, Point, Point]

/** Return corners in the only order accepted by the homography: TL, TR, BR, BL. */
export function orderQuad(points: Point[]): Quad | undefined {
  if (points.length !== 4 || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return undefined
  // Sum/difference ordering fails on diamonds and near-square perspective
  // crops because two corners can have the same sum. Sort around the centre
  // first, then rotate the clockwise loop so it begins at the visual TL.
  const unique = new Set(points.map(point => `${point.x}:${point.y}`))
  if (unique.size !== 4) return undefined
  const centre = points.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 })
  const loop = [...points].sort((a, b) => Math.atan2(a.y - centre.y, a.x - centre.x) - Math.atan2(b.y - centre.y, b.x - centre.x))
  let start = 0
  for (let index = 1; index < loop.length; index++) {
    const candidate = loop[index]
    const current = loop[start]
    if (candidate.x + candidate.y < current.x + current.y || (candidate.x + candidate.y === current.x + current.y && candidate.y < current.y)) start = index
  }
  const quad = [loop[start], loop[(start + 1) % 4], loop[(start + 2) % 4], loop[(start + 3) % 4]] as Quad
  return isConvexQuad(quad) && polygonArea(quad) > 4 ? quad : undefined
}

function polygonArea(points: Point[]) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]
    return sum + point.x * next.y - next.x * point.y
  }, 0)) / 2
}

function isConvexQuad(points: Quad) {
  let sign = 0
  for (let index = 0; index < 4; index++) {
    const a = points[index]
    const b = points[(index + 1) % 4]
    const c = points[(index + 2) % 4]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) < .0001) return false
    const nextSign = Math.sign(cross)
    if (sign && sign !== nextSign) return false
    sign = nextSign
  }
  return true
}

/** Reject noisy/default detector output before attempting a destructive crop. */
export function validQuad(points: Point[], width: number, height: number) {
  const quad = orderQuad(points)
  if (!quad || width < 2 || height < 2) return false
  const area = polygonArea(quad)
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
  const area = polygonArea(quad)
  const edgeLengths = quad.map((point, index) => {
    const next = quad[(index + 1) % quad.length]
    return Math.hypot(next.x - point.x, next.y - point.y)
  })
  const inBounds = quad.every(point => point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height)
  return inBounds && area > width * height * .012 && edgeLengths.every(length => length > Math.min(width, height) * .01)
}
/**
 * Create a transform from output-canvas coordinates back to the source quad.
 *
 * The output's last drawable pixel is width - 1 / height - 1. The earlier
 * width/height targets left a one-pixel strip inside the right and bottom
 * frame edges, which is especially visible after a tight camera crop.
 */
export function perspectiveTransform(source: Quad, width: number, height: number) {
  if (width < 2 || height < 2) return undefined
  const rows: number[][] = []
  const values: number[] = []
  const target = [{ x: 0, y: 0 }, { x: width - 1, y: 0 }, { x: width - 1, y: height - 1 }, { x: 0, y: height - 1 }]
  for (let index = 0; index < 4; index++) {
    const { x, y } = target[index]
    const { x: u, y: v } = source[index]
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    values.push(u)
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y])
    values.push(v)
  }
  for (let column = 0; column < 8; column++) {
    let pivot = column
    for (let row = column + 1; row < 8; row++) if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row
    ;[rows[column], rows[pivot]] = [rows[pivot], rows[column]]
    ;[values[column], values[pivot]] = [values[pivot], values[column]]
    const divisor = rows[column][column]
    if (!Number.isFinite(divisor) || Math.abs(divisor) < 1e-9) return undefined
    for (let cell = column; cell < 8; cell++) rows[column][cell] /= divisor
    values[column] /= divisor
    for (let row = 0; row < 8; row++) {
      if (row === column) continue
      const factor = rows[row][column]
      for (let cell = column; cell < 8; cell++) rows[row][cell] -= factor * rows[column][cell]
      values[row] -= factor * values[column]
    }
  }
  return values.every(Number.isFinite) ? [...values, 1] : undefined
}

/** Map an output pixel through a perspective transform to its source pixel. */
export function mapPerspectivePoint(transform: number[], x: number, y: number): Point | undefined {
  const denominator = transform[6] * x + transform[7] * y + 1
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) return undefined
  const sourceX = (transform[0] * x + transform[1] * y + transform[2]) / denominator
  const sourceY = (transform[3] * x + transform[4] * y + transform[5]) / denominator
  return Number.isFinite(sourceX) && Number.isFinite(sourceY) ? { x: sourceX, y: sourceY } : undefined
}

const MAX_CROP_EDGE = 4096
const MAX_CROP_PIXELS = 12_000_000

/** Bound allocations on very large imported camera images while preserving the crop ratio. */
export function cappedCropSize(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  const scale = Math.min(1, MAX_CROP_EDGE / Math.max(width, height), Math.sqrt(MAX_CROP_PIXELS / (width * height)))
  return { width: Math.max(2, Math.floor(width * scale)), height: Math.max(2, Math.floor(height * scale)) }
}
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
  const outputSize = cappedCropSize(Math.max(topWidth, bottomWidth), Math.max(leftHeight, rightHeight))
  if (!outputSize) { bitmap.close(); return file }
  const { width: outputWidth, height: outputHeight } = outputSize
  const h = perspectiveTransform(quad, outputWidth, outputHeight)
  if (!h) { bitmap.close(); return file }
  const samplePoints = [{ x: 0, y: 0 }, { x: outputWidth - 1, y: 0 }, { x: outputWidth - 1, y: outputHeight - 1 }, { x: 0, y: outputHeight - 1 }, { x: (outputWidth - 1) / 2, y: (outputHeight - 1) / 2 }]
  if (samplePoints.some(point => !mapPerspectivePoint(h, point.x, point.y))) { bitmap.close(); return file }
  const output = new ImageData(outputWidth, outputHeight)
  for (let y = 0; y < outputHeight; y++) for (let x = 0; x < outputWidth; x++) {
    const mapped = mapPerspectivePoint(h, x, y)
    // A convex, validated quad cannot cross its projective horizon. Retain a
    // safe source pixel if an extreme numerical case still reaches one.
    const sourceX = clamp(mapped?.x ?? 0, 0, bitmap.width - 1)
    const sourceY = clamp(mapped?.y ?? 0, 0, bitmap.height - 1)
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
