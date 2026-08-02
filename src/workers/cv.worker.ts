/**
 * Lightweight, dependency-free document detector.
 *
 * The scanner sends a small camera frame (normally 480px wide) to this worker
 * every ~120ms.  We deliberately do the expensive work on a smaller image:
 * Sobel gradients are converted into a weighted Hough map, then the strongest
 * two pairs of parallel lines are fitted into a convex quadrilateral.  This is
 * considerably more useful than an axis-aligned connected-component box for a
 * page held at an angle, while keeping the PWA fully local and offline.
 */

type PixelFrame = { data: ArrayBuffer; width: number; height: number }
type Point = { x: number; y: number }
type Detection = {
  corners: [Point, Point, Point, Point]
  frameWidth: number
  frameHeight: number
  confidence: number
  blurScore: number
  guidance: 'searching' | 'ready' | 'move-closer'
}

type Line = { theta: number; rho: number; score: number; nx: number; ny: number }
type Quad = { corners: [Point, Point, Point, Point]; score: number; area: number }

const HALF_PI = Math.PI / 2
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const finite = (value: number) => Number.isFinite(value)

/** Difference between two orientations where pi radians is the same line. */
function orientationDistance(a: number, b: number) {
  let d = Math.abs(a - b) % Math.PI
  if (d > HALF_PI) d = Math.PI - d
  return d
}

function percentile(values: number[], fraction: number) {
  if (!values.length) return 0
  values.sort((a, b) => a - b)
  return values[Math.floor(clamp(fraction, 0, 1) * (values.length - 1))]
}

function cross(a: Point, b: Point, c: Point) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function polygonArea(points: Point[]) {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]; const b = points[(i + 1) % points.length]
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum) / 2
}

function orderCorners(points: Point[]): [Point, Point, Point, Point] | undefined {
  if (points.length !== 4 || points.some(p => !finite(p.x) || !finite(p.y))) return undefined
  // This ordering remains stable for pages with moderate perspective and is
  // exactly the order expected by perspectiveCrop (TL, TR, BR, BL).
  const topLeft = points.reduce((best, p) => p.x + p.y < best.x + best.y ? p : best)
  const bottomRight = points.reduce((best, p) => p.x + p.y > best.x + best.y ? p : best)
  const topRight = points.reduce((best, p) => p.x - p.y > best.x - best.y ? p : best)
  const bottomLeft = points.reduce((best, p) => p.x - p.y < best.x - best.y ? p : best)
  const ordered = [topLeft, topRight, bottomRight, bottomLeft] as [Point, Point, Point, Point]
  const unique = new Set(ordered.map(p => `${Math.round(p.x * 10)}:${Math.round(p.y * 10)}`))
  if (unique.size !== 4 || polygonArea(ordered) < 1) return undefined
  const signs = ordered.map((_, i) => Math.sign(cross(ordered[i], ordered[(i + 1) % 4], ordered[(i + 2) % 4])))
  if (signs.some(s => s !== 0 && s !== signs.find(Boolean))) return undefined
  return ordered
}

function intersection(a: Line, b: Line): Point | undefined {
  const determinant = a.nx * b.ny - a.ny * b.nx
  if (Math.abs(determinant) < 0.04) return undefined
  return {
    x: (a.rho * b.ny - a.ny * b.rho) / determinant,
    y: (a.nx * b.rho - a.rho * b.nx) / determinant,
  }
}

function lineSupport(lineA: Point, lineB: Point, gradients: Float32Array, width: number, height: number, threshold: number) {
  const length = Math.hypot(lineB.x - lineA.x, lineB.y - lineA.y)
  const samples = Math.max(12, Math.round(length / 3))
  let score = 0
  let valid = 0
  for (let i = 0; i <= samples; i++) {
    const t = i / samples; const x = lineA.x + (lineB.x - lineA.x) * t; const y = lineA.y + (lineB.y - lineA.y) * t
    let peak = 0
    // A 5px search band compensates for quantisation in the Hough map and
    // for soft document edges caused by camera focus or motion blur.
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const px = Math.round(x + dx); const py = Math.round(y + dy)
      if (px >= 0 && py >= 0 && px < width && py < height) peak = Math.max(peak, gradients[py * width + px])
    }
    score += clamp(peak / Math.max(1, threshold * 2.2), 0, 1)
    valid++
  }
  return valid ? score / valid : 0
}

function pointInPolygon(point: Point, polygon: Point[]) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]; const b = polygon[j]
    const hit = (a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    if (hit) inside = !inside
  }
  return inside
}

function detectDocument(pixels: Uint8ClampedArray, width: number, height: number): Detection {
  const maxDimension = 220
  const scale = Math.min(1, maxDimension / Math.max(width, height))
  const smallWidth = Math.max(80, Math.round(width * scale))
  const smallHeight = Math.max(60, Math.round(height * scale))
  const gray = new Uint8Array(smallWidth * smallHeight)
  const sourceX = width / smallWidth; const sourceY = height / smallHeight

  for (let y = 0; y < smallHeight; y++) for (let x = 0; x < smallWidth; x++) {
    const sx = Math.min(width - 1, Math.floor(x * sourceX)); const sy = Math.min(height - 1, Math.floor(y * sourceY))
    const i = (sy * width + sx) * 4
    gray[y * smallWidth + x] = pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722
  }

  const gradients = new Float32Array(smallWidth * smallHeight)
  const magnitudes: number[] = []
  let totalGradient = 0
  for (let y = 1; y < smallHeight - 1; y++) for (let x = 1; x < smallWidth - 1; x++) {
    const i = y * smallWidth + x
    // Sobel operator, with a cheap 3x3 blur folded into the neighbourhood.
    const gx = -gray[i - smallWidth - 1] - 2 * gray[i - 1] - gray[i + smallWidth - 1] + gray[i - smallWidth + 1] + 2 * gray[i + 1] + gray[i + smallWidth + 1]
    const gy = -gray[i - smallWidth - 1] - 2 * gray[i - smallWidth] - gray[i - smallWidth + 1] + gray[i + smallWidth - 1] + 2 * gray[i + smallWidth] + gray[i + smallWidth + 1]
    const magnitude = Math.hypot(gx, gy) / 4
    gradients[i] = magnitude; totalGradient += magnitude
    if (magnitude > 2) magnitudes.push(magnitude)
  }
  const p78 = percentile(magnitudes, 0.78)
  // Keep the threshold adaptive, but never let a low-contrast page disappear
  // completely.  A true page edge is normally >20 on this Sobel scale.
  const threshold = clamp(p78 * 0.62, 12, 56)
  const edgePixels = magnitudes.filter(m => m >= threshold).length
  const edgeDensity = edgePixels / Math.max(1, (smallWidth - 2) * (smallHeight - 2))

  const diagonal = Math.hypot(smallWidth, smallHeight)
  const thetaCount = 72 // 2.5-degree angular resolution; keeps live analysis responsive.
  const rhoBins = Math.ceil(diagonal * 2) + 1
  const rhoOffset = diagonal
  const accumulator = new Float32Array(thetaCount * rhoBins)
  const cos = new Float32Array(thetaCount); const sin = new Float32Array(thetaCount)
  for (let t = 0; t < thetaCount; t++) { const angle = t * Math.PI / thetaCount; cos[t] = Math.cos(angle); sin[t] = Math.sin(angle) }

  // Weighted Hough voting.  Ignore a narrow border where the video element's
  // own edge would otherwise become the highest scoring rectangle.
  for (let y = 2; y < smallHeight - 2; y++) for (let x = 2; x < smallWidth - 2; x++) {
    const magnitude = gradients[y * smallWidth + x]
    if (magnitude < threshold) continue
    const weight = clamp(magnitude, threshold, 180)
    for (let t = 0; t < thetaCount; t++) {
      const rho = Math.round(x * cos[t] + y * sin[t] + rhoOffset)
      accumulator[t * rhoBins + rho] += weight
    }
  }

  const peaks: Line[] = []
  for (let t = 0; t < thetaCount; t++) for (let r = 2; r < rhoBins - 2; r++) {
    const value = accumulator[t * rhoBins + r]
    if (value < threshold * 8) continue
    let localMaximum = true
    for (let dt = -2; dt <= 2 && localMaximum; dt++) for (let dr = -5; dr <= 5; dr++) {
      if (!dt && !dr) continue
      const neighbourT = (t + dt + thetaCount) % thetaCount
      if (accumulator[neighbourT * rhoBins + r + dr] > value) { localMaximum = false; break }
    }
    if (localMaximum) {
      peaks.push({ theta: t * Math.PI / thetaCount, rho: r - rhoOffset, score: value, nx: cos[t], ny: sin[t] })
    }
  }
  peaks.sort((a, b) => b.score - a.score)
  const lines: Line[] = []
  for (const peak of peaks) {
    // Non-maximum suppression across both angular and rho dimensions leaves a
    // compact set of real page/text lines for the pair search below.
    if (lines.some(line => orientationDistance(line.theta, peak.theta) < 0.12 && Math.abs(line.rho - peak.rho) < 14)) continue
    lines.push(peak)
    if (lines.length >= 28) break
  }

  const minSide = Math.min(smallWidth, smallHeight) * 0.16
  const candidates: Quad[] = []
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const first = [lines[i], lines[j]]
    // Perspective makes opposite edges converge; allow up to ~13 degrees
    // between their normals instead of requiring a perfectly parallel pair.
    if (orientationDistance(first[0].theta, first[1].theta) > 0.22 || Math.abs(first[0].rho - first[1].rho) < minSide) continue
    for (let k = 0; k < lines.length; k++) for (let l = k + 1; l < lines.length; l++) {
      if (k === i || k === j || l === i || l === j) continue
      const second = [lines[k], lines[l]]
      if (orientationDistance(second[0].theta, second[1].theta) > 0.22 || Math.abs(second[0].rho - second[1].rho) < minSide) continue
      if (Math.abs(orientationDistance(first[0].theta, second[0].theta) - HALF_PI) > 0.44) continue
      const p1 = intersection(first[0], second[0]); const p2 = intersection(first[1], second[0]); const p3 = intersection(first[1], second[1]); const p4 = intersection(first[0], second[1])
      if (!p1 || !p2 || !p3 || !p4) continue
      const raw = [p1, p2, p3, p4]
      if (raw.some(p => p.x < -smallWidth * .18 || p.x > smallWidth * 1.18 || p.y < -smallHeight * .18 || p.y > smallHeight * 1.18)) continue
      const corners = orderCorners(raw)
      if (!corners) continue
      const area = polygonArea(corners) / (smallWidth * smallHeight)
      if (area < 0.075 || area > 1.1) continue
      const lengths = corners.map((p, index) => Math.hypot(p.x - corners[(index + 1) % 4].x, p.y - corners[(index + 1) % 4].y))
      if (lengths.some(length => length < minSide)) continue
      const oppositeBalance = (Math.min(lengths[0], lengths[2]) / Math.max(lengths[0], lengths[2]) + Math.min(lengths[1], lengths[3]) / Math.max(lengths[1], lengths[3])) / 2
      const angleBalance = corners.reduce((sum, p, index) => {
        const previous = corners[(index + 3) % 4]; const next = corners[(index + 1) % 4]
        const a = { x: previous.x - p.x, y: previous.y - p.y }; const b = { x: next.x - p.x, y: next.y - p.y }
        return sum + clamp((a.x * b.x + a.y * b.y) / Math.max(1, Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)), -1, 1)
      }, 0)
      const rectangleScore = clamp(oppositeBalance * .65 + (1 - Math.abs(angleBalance) / 4) * .35, 0, 1)
      const sideSupport = corners.reduce((sum, point, index) => sum + lineSupport(point, corners[(index + 1) % 4], gradients, smallWidth, smallHeight, threshold), 0) / 4
      const centerScore = pointInPolygon({ x: smallWidth / 2, y: smallHeight / 2 }, corners) ? 1 : .45
      const sizeScore = clamp(area / .34, 0, 1)
      const score = clamp(sideSupport * .48 + rectangleScore * .2 + sizeScore * .2 + centerScore * .12, 0, 1)
      candidates.push({ corners, score, area })
    }
  }

  // Keep the best candidate, preferring a larger page when two line sets have
  // comparable support (this suppresses text-line false positives).
  candidates.sort((a, b) => (b.score - a.score) || (b.area - a.area))
  const best = candidates[0]
  let corners: [Point, Point, Point, Point]
  let confidence = 0
  if (best) {
    corners = best.corners.map(p => ({ x: p.x / scale, y: p.y / scale })) as [Point, Point, Point, Point]
    confidence = clamp(best.score * (edgeDensity > .008 ? 1 : .72), 0, 1)
  } else {
    // A conservative searching fallback.  It is intentionally not marked
    // ready, so capture remains user-controlled and the guide can recover on
    // the next frame without jumping to a random text box.
    corners = [
      { x: width * .08, y: height * .08 }, { x: width * .92, y: height * .08 },
      { x: width * .92, y: height * .92 }, { x: width * .08, y: height * .92 },
    ]
    confidence = clamp(edgeDensity * 1.8, 0, .3)
  }
  const area = polygonArea(corners) / Math.max(1, width * height)
  const blurScore = clamp((totalGradient / Math.max(1, (smallWidth - 2) * (smallHeight - 2))) / 38, 0, 1)
  const guidance = confidence > .56 && area > .22 ? 'ready' : area < .2 ? 'move-closer' : 'searching'
  return { corners, frameWidth: width, frameHeight: height, confidence, blurScore, guidance }
}

export { detectDocument }

if (typeof self !== 'undefined') self.onmessage = (event: MessageEvent<PixelFrame>) => {
  const { data, width, height } = event.data
  if (!data || width < 20 || height < 20) return
  const pixels = new Uint8ClampedArray(data)
  self.postMessage(detectDocument(pixels, width, height))
}
