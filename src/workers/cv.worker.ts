type PixelFrame = { data: ArrayBuffer; width: number; height: number }
type Point = { x: number; y: number }
type Detection = { corners: [Point, Point, Point, Point]; frameWidth: number; frameHeight: number; confidence: number; blurScore: number; guidance: 'searching' | 'ready' | 'move-closer' }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const component = (binary: Uint8Array, width: number, height: number, start: number, seen: Uint8Array) => {
  const queue = [start]; seen[start] = 1; let head = 0; let count = 0; let minX = width; let minY = height; let maxX = 0; let maxY = 0
  while (head < queue.length && count < binary.length * .95) { const index = queue[head++]; const x = index % width; const y = Math.floor(index / width); count++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); const next = [index - 1, index + 1, index - width, index + width]; for (const candidate of next) if (candidate >= 0 && candidate < binary.length && !seen[candidate] && binary[candidate]) { const cx = candidate % width; if (Math.abs(cx - x) <= 1) { seen[candidate] = 1; queue.push(candidate) } } }
  return { count, minX, minY, maxX, maxY }
}

self.onmessage = (event: MessageEvent<PixelFrame>) => {
  const { data, width, height } = event.data; const pixels = new Uint8ClampedArray(data); const gray = new Uint8Array(width * height); let cornerMean = 0; const cornerSamples = Math.max(1, Math.floor(Math.min(width, height) * .08))
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const index = (y * width + x) * 4; gray[y * width + x] = pixels[index] * .2126 + pixels[index + 1] * .7152 + pixels[index + 2] * .0722; if ((x < cornerSamples || x > width - cornerSamples) && (y < cornerSamples || y > height - cornerSamples)) cornerMean += gray[y * width + x] }
  cornerMean /= cornerSamples * cornerSamples * 4
  const binary = new Uint8Array(width * height); const edge = new Uint8Array(width * height); let edgeCount = 0
  for (let y = 2; y < height - 2; y += 2) for (let x = 2; x < width - 2; x += 2) { const index = y * width + x; const gx = gray[index + 2] - gray[index - 2]; const gy = gray[index + width * 2] - gray[index - width * 2]; const magnitude = Math.abs(gx) + Math.abs(gy); if (magnitude > 72) { edge[index] = 1; edgeCount++ } if (gray[index] > cornerMean + 15 || gray[index] < cornerMean - 28) binary[index] = 1 }
  let best = { count: 0, minX: Math.floor(width * .08), minY: Math.floor(height * .08), maxX: Math.floor(width * .92), maxY: Math.floor(height * .92) }; const visited = new Uint8Array(binary.length)
  for (let y = Math.floor(height * .08); y < height * .9; y += 4) for (let x = Math.floor(width * .08); x < width * .9; x += 4) { const index = y * width + x; if (binary[index] && !visited[index]) { const found = component(binary, width, height, index, visited); if (found.count > best.count) best = found } }
  if (best.count < width * height * .06) { let minX = width; let minY = height; let maxX = 0; let maxY = 0; for (let y = 2; y < height - 2; y += 2) for (let x = 2; x < width - 2; x += 2) if (edge[y * width + x]) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) } best = { count: edgeCount, minX, minY, maxX, maxY } }
  const left = clamp(best.minX, width * .04, width * .94); const right = clamp(best.maxX, width * .06, width * .96); const top = clamp(best.minY, height * .04, height * .94); const bottom = clamp(best.maxY, height * .06, height * .96); let tl = { x: left, y: top }; let tr = { x: right, y: top }; let br = { x: right, y: bottom }; let bl = { x: left, y: bottom }; let minSum = Infinity; let maxSum = -Infinity; let minDiff = Infinity; let maxDiff = -Infinity
  for (let y = Math.floor(top); y <= bottom; y += 2) for (let x = Math.floor(left); x <= right; x += 2) if (edge[y * width + x] || binary[y * width + x]) { const sum = x + y; const diff = x - y; if (sum < minSum) { minSum = sum; tl = { x, y } } if (sum > maxSum) { maxSum = sum; br = { x, y } } if (diff > maxDiff) { maxDiff = diff; tr = { x, y } } if (diff < minDiff) { minDiff = diff; bl = { x, y } } }
  const area = Math.max(0, right - left) * Math.max(0, bottom - top) / (width * height); const aspect = (right - left) / Math.max(1, bottom - top); const rectangularity = aspect > .35 && aspect < 2.8 ? 1 : .45; const confidence = clamp(area * 1.45 * rectangularity * (edgeCount > width * height * .015 ? 1 : .65), 0, 1); const blurScore = clamp(edgeCount / (width * height * .08), 0, 1)
  const result: Detection = { corners: [tl, tr, br, bl], frameWidth: width, frameHeight: height, confidence, blurScore, guidance: confidence > .48 ? 'ready' : area < .24 ? 'move-closer' : 'searching' }
  self.postMessage(result)
}
