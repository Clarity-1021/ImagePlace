import { cropRaster, type Raster } from "./raster"

const CONNECT_ALPHA = 24

export type Sprite = Raster & {
  sheetX: number
  sheetY: number
  area: number
}

export type SplitOptions = {
  minArea?: number
  maxSprites?: number
}

export type SplitResult = {
  sprites: Sprite[]
  truncated: boolean
}

export function splitSprites(
  sheet: Raster,
  options: SplitOptions = {},
): SplitResult {
  const { width, height, data } = sheet
  const count = width * height
  const minArea = options.minArea ?? Math.max(24, Math.round(count * 0.00003))
  const maxSprites = options.maxSprites ?? 40
  const labels = new Int32Array(count)
  const parent = new Uint32Array(count + 1)
  let nextLabel = 1

  const find = (label: number): number => {
    let root = label
    while (parent[root] !== root) root = parent[root]
    while (parent[label] !== label) {
      const next = parent[label]
      parent[label] = root
      label = next
    }
    return root
  }

  const union = (left: number, right: number) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
  }

  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const index = row + x
      if (data[index * 4 + 3] < CONNECT_ALPHA) continue
      let best = 0
      const consider = (neighbor: number) => {
        if (!neighbor) return
        if (!best || neighbor < best) best = neighbor
      }
      if (x > 0) consider(labels[index - 1])
      if (y > 0) {
        consider(labels[index - width])
        if (x > 0) consider(labels[index - width - 1])
        if (x + 1 < width) consider(labels[index - width + 1])
      }
      if (!best) {
        labels[index] = nextLabel
        parent[nextLabel] = nextLabel
        nextLabel++
      } else {
        labels[index] = best
        if (x > 0 && labels[index - 1]) union(best, labels[index - 1])
        if (y > 0 && labels[index - width]) union(best, labels[index - width])
        if (y > 0 && x > 0 && labels[index - width - 1]) {
          union(best, labels[index - width - 1])
        }
        if (y > 0 && x + 1 < width && labels[index - width + 1]) {
          union(best, labels[index - width + 1])
        }
      }
    }
  }

  type Accumulator = {
    area: number
    minX: number
    minY: number
    maxX: number
    maxY: number
  }
  const groups = new Map<number, Accumulator>()
  for (let index = 0; index < count; index++) {
    const label = labels[index]
    if (!label) continue
    const root = find(label)
    labels[index] = root
    const x = index % width
    const y = (index / width) | 0
    const group = groups.get(root)
    if (!group) {
      groups.set(root, { area: 1, minX: x, minY: y, maxX: x, maxY: y })
    } else {
      group.area++
      if (x < group.minX) group.minX = x
      if (y < group.minY) group.minY = y
      if (x > group.maxX) group.maxX = x
      if (y > group.maxY) group.maxY = y
    }
  }

  const qualified = [...groups.entries()].filter(
    ([, group]) => group.area >= minArea,
  )
  qualified.sort((left, right) => right[1].area - left[1].area)
  const truncated = qualified.length > maxSprites
  const kept = qualified.slice(0, maxSprites)

  const sprites: Sprite[] = kept.map(([id, group]) => {
    const boxWidth = group.maxX - group.minX + 1
    const boxHeight = group.maxY - group.minY + 1
    const cropped = cropRaster(
      sheet,
      group.minX,
      group.minY,
      boxWidth,
      boxHeight,
    )
    for (let y = 0; y < boxHeight; y++) {
      for (let x = 0; x < boxWidth; x++) {
        const sheetIndex = (group.minY + y) * width + (group.minX + x)
        const root = labels[sheetIndex]
        const alpha = data[sheetIndex * 4 + 3]
        if (root === id || (root === 0 && alpha > 0)) continue
        const pixel = (y * boxWidth + x) * 4
        cropped.data[pixel] = 0
        cropped.data[pixel + 1] = 0
        cropped.data[pixel + 2] = 0
        cropped.data[pixel + 3] = 0
      }
    }
    return {
      ...cropped,
      sheetX: group.minX,
      sheetY: group.minY,
      area: group.area,
    }
  })

  return { sprites: readingOrder(sprites), truncated }
}

function readingOrder(sprites: Sprite[]): Sprite[] {
  const pending = [...sprites].sort(
    (left, right) => left.sheetY - right.sheetY || left.sheetX - right.sheetX,
  )
  const rows: Sprite[][] = []
  for (const sprite of pending) {
    const row = rows.find((candidate) => {
      const top = Math.min(...candidate.map((item) => item.sheetY))
      const bottom = Math.max(
        ...candidate.map((item) => item.sheetY + item.height),
      )
      const overlap =
        Math.min(bottom, sprite.sheetY + sprite.height) -
        Math.max(top, sprite.sheetY)
      const minHeight = Math.min(
        sprite.height,
        ...candidate.map((item) => item.height),
      )
      return overlap > minHeight * 0.45
    })
    if (row) row.push(sprite)
    else rows.push([sprite])
  }
  const ordered: Sprite[] = []
  for (const row of rows) {
    row.sort((left, right) => left.sheetX - right.sheetX)
    ordered.push(...row)
  }
  return ordered
}
