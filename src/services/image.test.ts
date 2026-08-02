import { describe, expect, it } from 'vitest'
import { enhancePixels, monotonePixels } from './image'

function pixel(data: Uint8ClampedArray, index: number) {
  const offset = index * 4
  return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]]
}

describe('scan filters', () => {
  it('enhance adapts exposure while preserving colour', () => {
    const data = new Uint8ClampedArray([
      38, 72, 116, 255,
      224, 230, 236, 255,
    ])
    enhancePixels(data, 2, 1)
    const darkPixel = pixel(data, 0)
    const lightPixel = pixel(data, 1)
    expect(darkPixel[0]).toBeLessThan(darkPixel[2])
    expect(lightPixel[0]).toBeLessThanOrEqual(255)
    expect(darkPixel[0]).not.toBe(38)
    expect(lightPixel[0]).toBeGreaterThan(darkPixel[0])
  })

  it('enhance keeps a mostly-white paper background white', () => {
    const data = new Uint8ClampedArray(10 * 10 * 4)
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 255
      data[index + 1] = 255
      data[index + 2] = 255
      data[index + 3] = 255
    }
    data[0] = 24
    data[1] = 24
    data[2] = 24
    enhancePixels(data, 10, 10)
    expect(pixel(data, 1)[0]).toBeGreaterThanOrEqual(245)
    expect(pixel(data, 0)[0]).toBeLessThan(80)
  })

  it('enhance does not invent contrast in a flat mid-tone image', () => {
    const data = new Uint8ClampedArray(8 * 8 * 4)
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 200
      data[index + 1] = 200
      data[index + 2] = 200
      data[index + 3] = 255
    }
    enhancePixels(data, 8, 8)
    expect(pixel(data, 10)[0]).toBeGreaterThanOrEqual(190)
    expect(pixel(data, 10)[0]).toBeLessThanOrEqual(215)
  })

  it('monotone follows uneven page lighting and writes equal channels', () => {
    const width = 48
    const height = 24
    const data = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const background = x < width / 2 ? 92 : 214
        const offset = (y * width + x) * 4
        data[offset] = background
        data[offset + 1] = background
        data[offset + 2] = background
        data[offset + 3] = 255
      }
    }
    // The same dark ink mark appears on both halves of the page.
    for (const x of [10, 36]) {
      const offset = (12 * width + x) * 4
      data[offset] = 24
      data[offset + 1] = 24
      data[offset + 2] = 24
    }
    monotonePixels(data, width, height)
    const leftPaper = pixel(data, 8 * width + 10)
    const rightPaper = pixel(data, 8 * width + 36)
    const leftInk = pixel(data, 12 * width + 10)
    const rightInk = pixel(data, 12 * width + 36)
    expect(leftPaper[0]).toBe(leftPaper[1])
    expect(leftPaper[1]).toBe(leftPaper[2])
    expect(rightPaper[0]).toBe(rightPaper[1])
    expect(rightPaper[0]).toBeGreaterThan(leftPaper[0])
    expect(leftInk[0]).toBeLessThan(leftPaper[0])
    expect(rightInk[0]).toBeLessThan(rightPaper[0])
  })
})
