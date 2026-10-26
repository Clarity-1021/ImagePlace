export type Raster = {
  width: number
  height: number
  data: Uint8ClampedArray
}

export type Rgba = [number, number, number, number]

export function createRaster(
  width: number,
  height: number,
  fill?: Rgba,
): Raster {
  const data = new Uint8ClampedArray(width * height * 4)
  if (fill) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fill[0]
      data[i + 1] = fill[1]
      data[i + 2] = fill[2]
      data[i + 3] = fill[3]
    }
  }
  return { width, height, data }
}

export function cloneRaster(source: Raster): Raster {
  return {
    width: source.width,
    height: source.height,
    data: new Uint8ClampedArray(source.data),
  }
}

export function setPixel(
  raster: Raster,
  x: number,
  y: number,
  color: Rgba,
): void {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return
  const index = (y * raster.width + x) * 4
  raster.data[index] = color[0]
  raster.data[index + 1] = color[1]
  raster.data[index + 2] = color[2]
  raster.data[index + 3] = color[3]
}

export function blitOpaque(
  destination: Raster,
  source: Raster,
  offsetX: number,
  offsetY: number,
): void {
  for (let y = 0; y < source.height; y++) {
    const targetY = offsetY + y
    if (targetY < 0 || targetY >= destination.height) continue
    for (let x = 0; x < source.width; x++) {
      const targetX = offsetX + x
      if (targetX < 0 || targetX >= destination.width) continue
      const sourceIndex = (y * source.width + x) * 4
      if (source.data[sourceIndex + 3] === 0) continue
      const targetIndex = (targetY * destination.width + targetX) * 4
      destination.data[targetIndex] = source.data[sourceIndex]
      destination.data[targetIndex + 1] = source.data[sourceIndex + 1]
      destination.data[targetIndex + 2] = source.data[sourceIndex + 2]
      destination.data[targetIndex + 3] = source.data[sourceIndex + 3]
    }
  }
}

export function cropRaster(
  source: Raster,
  originX: number,
  originY: number,
  width: number,
  height: number,
): Raster {
  const raster = createRaster(width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceX = originX + x
      const sourceY = originY + y
      if (
        sourceX < 0 ||
        sourceY < 0 ||
        sourceX >= source.width ||
        sourceY >= source.height
      ) {
        continue
      }
      const sourceIndex = (sourceY * source.width + sourceX) * 4
      const targetIndex = (y * width + x) * 4
      raster.data[targetIndex] = source.data[sourceIndex]
      raster.data[targetIndex + 1] = source.data[sourceIndex + 1]
      raster.data[targetIndex + 2] = source.data[sourceIndex + 2]
      raster.data[targetIndex + 3] = source.data[sourceIndex + 3]
    }
  }
  return raster
}

export function hasTransparency(raster: Raster): boolean {
  const data = raster.data
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < 250) return true
  }
  return false
}

export function resample(source: Raster, width: number, height: number): Raster {
  if (source.width === width && source.height === height) return source
  const data = new Uint8ClampedArray(width * height * 4)
  const scaleX = source.width / width
  const scaleY = source.height / height
  for (let y = 0; y < height; y++) {
    const sourceY = (y + 0.5) * scaleY - 0.5
    const y0 = Math.max(0, Math.floor(sourceY))
    const y1 = Math.min(source.height - 1, y0 + 1)
    const blendY = Math.min(1, Math.max(0, sourceY - y0))
    for (let x = 0; x < width; x++) {
      const sourceX = (x + 0.5) * scaleX - 0.5
      const x0 = Math.max(0, Math.floor(sourceX))
      const x1 = Math.min(source.width - 1, x0 + 1)
      const blendX = Math.min(1, Math.max(0, sourceX - x0))
      const i00 = (y0 * source.width + x0) * 4
      const i10 = (y0 * source.width + x1) * 4
      const i01 = (y1 * source.width + x0) * 4
      const i11 = (y1 * source.width + x1) * 4
      const output = (y * width + x) * 4
      const invX = 1 - blendX
      const invY = 1 - blendY
      for (let channel = 0; channel < 4; channel++) {
        data[output + channel] =
          source.data[i00 + channel] * invX * invY +
          source.data[i10 + channel] * blendX * invY +
          source.data[i01 + channel] * invX * blendY +
          source.data[i11 + channel] * blendX * blendY
      }
    }
  }
  return { width, height, data }
}

export function downsampleLongSide(
  source: Raster,
  longSide: number,
): { image: Raster; scaleX: number; scaleY: number } {
  const longest = Math.max(source.width, source.height)
  if (longest <= longSide) {
    return { image: source, scaleX: 1, scaleY: 1 }
  }
  const scale = longSide / longest
  const width = Math.max(1, Math.round(source.width * scale))
  const height = Math.max(1, Math.round(source.height * scale))
  return {
    image: resample(source, width, height),
    scaleX: width / source.width,
    scaleY: height / source.height,
  }
}

export function differenceMask(
  reference: Raster,
  base: Raster,
  threshold = 48,
): Uint8Array {
  const count = reference.width * reference.height
  const mask = new Uint8Array(count)
  const left = reference.data
  const right = base.data
  for (let index = 0, pixel = 0; index < count; index++, pixel += 4) {
    const sad =
      Math.abs(left[pixel] - right[pixel]) +
      Math.abs(left[pixel + 1] - right[pixel + 1]) +
      Math.abs(left[pixel + 2] - right[pixel + 2])
    if (sad > threshold) mask[index] = 1
  }
  return mask
}

export function dilateMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  if (radius <= 0) return mask
  const output = mask.slice()
  const seeds: number[] = []
  for (let index = 0; index < mask.length; index++) {
    if (mask[index]) seeds.push(index)
  }
  for (const index of seeds) {
    const x = index % width
    const y = (index / width) | 0
    for (let offsetY = -radius; offsetY <= radius; offsetY++) {
      const nextY = y + offsetY
      if (nextY < 0 || nextY >= height) continue
      for (let offsetX = -radius; offsetX <= radius; offsetX++) {
        const nextX = x + offsetX
        if (nextX < 0 || nextX >= width) continue
        output[nextY * width + nextX] = 1
      }
    }
  }
  return output
}
