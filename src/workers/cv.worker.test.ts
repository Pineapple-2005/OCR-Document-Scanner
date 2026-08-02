import { describe, expect, it } from 'vitest'
import { detectDocument } from './cv.worker'

function insidePolygon(x: number, y: number, polygon: Array<{ x: number; y: number }>) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]; const b = polygon[j]
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

describe('local document detector', () => {
  it('returns a perspective quad for a skewed page rather than an axis-aligned box', () => {
    const width = 240; const height = 160
    const page = [{ x: 36, y: 25 }, { x: 199, y: 14 }, { x: 211, y: 140 }, { x: 25, y: 149 }]
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const inPage = insidePolygon(x, y, page)
      const edge = page.some((point, index) => {
        const next = page[(index + 1) % page.length]
        const cross = Math.abs((next.x - point.x) * (y - point.y) - (next.y - point.y) * (x - point.x))
        const length = Math.hypot(next.x - point.x, next.y - point.y)
        return cross / Math.max(1, length) < 2.4
      })
      const value = edge ? 20 : inPage ? 238 : 42
      const i = (y * width + x) * 4
      pixels[i] = value; pixels[i + 1] = value; pixels[i + 2] = value; pixels[i + 3] = 255
    }
    const result = detectDocument(pixels, width, height)
    expect(result.confidence).toBeGreaterThan(0.35)
    expect(result.corners[0].x).toBeLessThan(result.corners[1].x)
    expect(result.corners[0].y).toBeLessThan(result.corners[3].y)
    // A perspective fit should not collapse to the old fixed .08/.92 box.
    expect(Math.abs(result.corners[0].x - width * .08)).toBeGreaterThan(3)
    const meanCornerError = result.corners.reduce((sum, point, index) => sum + Math.hypot(point.x - page[index].x, point.y - page[index].y), 0) / 4
    expect(meanCornerError).toBeLessThan(16)
  })

  it('does not report a confident page for a flat, textureless frame', () => {
    const width = 240; const height = 160
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 96; pixels[i + 1] = 96; pixels[i + 2] = 96; pixels[i + 3] = 255 }
    const result = detectDocument(pixels, width, height)
    expect(result.confidence).toBeLessThan(0.35)
    expect(result.guidance).not.toBe('ready')
  })

  it.each([
    { points: [[48, 30], [190, 15], [222, 128], [32, 150]] },
    { points: [[22, 34], [198, 40], [208, 145], [38, 132]] },
    { points: [[18, 20], [180, 60], [221, 143], [35, 130]] },
  ])('tracks a page when its perspective changes ($points)', ({ points: pagePoints }) => {
    const width = 240; const height = 160
    const page = pagePoints.map(([x, y]) => ({ x, y }))
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const inPage = insidePolygon(x, y, page)
      const value = inPage ? 224 : 48
      const i = (y * width + x) * 4
      pixels[i] = value; pixels[i + 1] = value; pixels[i + 2] = value; pixels[i + 3] = 255
    }
    const result = detectDocument(pixels, width, height)
    expect(result.confidence).toBeGreaterThan(0.3)
    expect(result.corners.every(point => point.x >= -8 && point.x <= width + 8 && point.y >= -8 && point.y <= height + 8)).toBe(true)
  })

})
