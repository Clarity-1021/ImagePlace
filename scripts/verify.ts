import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { placeItems, type Placement } from "../src/lib/place"
import {
  blitOpaque,
  createRaster,
  cropRaster,
  resample,
  setPixel,
  type Raster,
  type Rgba,
} from "../src/lib/raster"
import { splitSprites } from "../src/lib/split-sprites"
import { decodePng, encodePng } from "./png"

const root = path.resolve(import.meta.dirname, "..")
const fixtureDir = path.join(root, "public", "fixtures")

type Expected = { x: number; y: number; width: number; height: number }

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function patternColor(x: number, y: number): Rgba {
  const on = ((x >> 2) ^ (y >> 2)) & 1
  return on ? [186, 48, 42, 255] : [32, 78, 168, 255]
}

function fillPattern(raster: Raster, x: number, y: number, width: number, height: number) {
  for (let yy = 0; yy < height; yy++) {
    for (let xx = 0; xx < width; xx++) {
      setPixel(raster, x + xx, y + yy, patternColor(xx, yy))
    }
  }
}

function nearestUpscale(source: Raster, factor: number): Raster {
  const raster = createRaster(source.width * factor, source.height * factor)
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      const sourceX = Math.floor(x / factor)
      const sourceY = Math.floor(y / factor)
      const from = (sourceY * source.width + sourceX) * 4
      const to = (y * raster.width + x) * 4
      raster.data[to] = source.data[from]
      raster.data[to + 1] = source.data[from + 1]
      raster.data[to + 2] = source.data[from + 2]
      raster.data[to + 3] = source.data[from + 3]
    }
  }
  return raster
}

function sheetFrom(sprite: Raster, pad = 12): Raster {
  const sheet = createRaster(sprite.width + pad * 2, sprite.height + pad * 2)
  blitOpaque(sheet, sprite, pad, pad)
  return sheet
}

async function expectPlacements(
  label: string,
  reference: Raster,
  base: Raster,
  items: Raster,
  expected: Expected[],
  tolerance = 4,
) {
  const started = Date.now()
  const result = await placeItems(reference, base, items)
  const elapsed = Date.now() - started
  assert(result.ok, `${label}: expected a placement, got ${result.ok ? "" : result.code}`)
  assert(
    result.sprites.length === expected.length,
    `${label}: expected ${expected.length} sprites, got ${result.sprites.length}`,
  )
  const used = new Set<number>()
  for (const placement of result.placements) {
    let best = -1
    let bestDistance = Infinity
    expected.forEach((target, index) => {
      if (used.has(index)) return
      const distance = Math.hypot(
        placement.x + placement.width / 2 - (target.x + target.width / 2),
        placement.y + placement.height / 2 - (target.y + target.height / 2),
      )
      if (distance < bestDistance) {
        bestDistance = distance
        best = index
      }
    })
    assert(best >= 0, `${label}: no expected target left`)
    used.add(best)
    const target = expected[best]
    const widthDelta = Math.abs(placement.width - target.width)
    const heightDelta = Math.abs(placement.height - target.height)
    console.log(
      `${label} #${best} -> (${placement.x}, ${placement.y}) ${placement.width}x${placement.height} scale=${placement.scale.toFixed(2)} sad=${placement.meanSad.toFixed(2)} dist=${bestDistance.toFixed(1)}`,
    )
    assert(bestDistance <= tolerance, `${label}: center off by ${bestDistance.toFixed(1)}px`)
    assert(widthDelta <= tolerance && heightDelta <= tolerance, `${label}: size off by ${widthDelta}x${heightDelta}`)
    assert(placement.meanSad < 18, `${label}: appearance score ${placement.meanSad.toFixed(1)} is too weak`)
  }
  console.log(`${label} ok in ${elapsed}ms`)
  return result
}

async function testExactCrop() {
  const reference = createRaster(90, 70, [244, 236, 220, 255])
  const sprite = createRaster(28, 18)
  fillPattern(sprite, 0, 0, 28, 18)
  blitOpaque(reference, sprite, 18, 14)
  const base = createRaster(90, 70, [244, 236, 220, 255])
  await expectPlacements("exact crop", reference, base, sheetFrom(sprite), [
    { x: 18, y: 14, width: 28, height: 18 },
  ])
}

async function testUniqueAssignment() {
  const reference = createRaster(160, 80, [236, 228, 210, 255])
  const sprite = createRaster(22, 22)
  fillPattern(sprite, 0, 0, 22, 22)
  blitOpaque(reference, sprite, 12, 20)
  blitOpaque(reference, sprite, 110, 28)
  const base = createRaster(160, 80, [236, 228, 210, 255])
  const sheet = createRaster(120, 40)
  blitOpaque(sheet, sprite, 8, 8)
  blitOpaque(sheet, sprite, 70, 9)
  await expectPlacements("unique assignment", reference, base, sheet, [
    { x: 12, y: 20, width: 22, height: 22 },
    { x: 110, y: 28, width: 22, height: 22 },
  ])
}

async function testScaledSprite() {
  const reference = createRaster(180, 140, [248, 240, 226, 255])
  const sprite = createRaster(36, 24)
  fillPattern(sprite, 0, 0, 36, 24)
  blitOpaque(reference, sprite, 40, 30)
  const base = createRaster(180, 140, [248, 240, 226, 255])
  const enlarged = nearestUpscale(sprite, 2)
  const result = await expectPlacements(
    "half scale",
    reference,
    base,
    sheetFrom(enlarged, 16),
    [{ x: 40, y: 30, width: 36, height: 24 }],
    6,
  )
  assert(result.ok, "half scale result")
  const scale = result.placements[0].scale
  assert(Math.abs(scale - 0.5) < 0.01, `expected scale 0.5, got ${scale}`)
}

async function testBaseResize() {
  const background = createRaster(120, 80, [230, 214, 186, 255])
  fillPattern(background, 4, 4, 16, 10)
  const reference = structuredCloneRaster(background)
  const sprite = createRaster(26, 16)
  fillPattern(sprite, 0, 0, 26, 16)
  blitOpaque(reference, sprite, 48, 28)
  const base = resample(background, 60, 40)
  const result = await expectPlacements("resized base", reference, base, sheetFrom(sprite), [
    { x: 48, y: 28, width: 26, height: 16 },
  ])
  assert(result.ok && result.sizeAdjusted, "base size should be reported")
}

async function testRejectionsAndSplit() {
  const opaque = createRaster(16, 16, [20, 20, 20, 255])
  const rejected = await placeItems(opaque, opaque, opaque)
  assert(!rejected.ok && rejected.code === "no-alpha", "opaque items should fail")

  const empty = createRaster(20, 20)
  const missing = await placeItems(opaque, opaque, empty)
  assert(!missing.ok && missing.code === "no-items", "blank sheet should fail")

  const diagonal = createRaster(6, 6)
  setPixel(diagonal, 1, 1, [255, 0, 0, 255])
  setPixel(diagonal, 2, 2, [255, 0, 0, 255])
  const joined = splitSprites(diagonal, { minArea: 1 })
  assert(joined.sprites.length === 1, `diagonal pixels should be one sprite, got ${joined.sprites.length}`)

  const apart = createRaster(8, 4)
  setPixel(apart, 0, 0, [0, 0, 255, 255])
  setPixel(apart, 3, 0, [0, 0, 255, 255])
  const split = splitSprites(apart, { minArea: 1 })
  assert(split.sprites.length === 2, `separated pixels should be two sprites, got ${split.sprites.length}`)

  const speck = createRaster(30, 20)
  fillPattern(speck, 4, 4, 18, 12)
  setPixel(speck, 0, 0, [0, 255, 0, 255])
  setPixel(speck, 1, 0, [0, 255, 0, 255])
  const dropped = splitSprites(speck, { minArea: 10 })
  assert(dropped.sprites.length === 1, "speck should be dropped")
  console.log("rejections and split ok")
}

function structuredCloneRaster(source: Raster): Raster {
  return {
    width: source.width,
    height: source.height,
    data: new Uint8ClampedArray(source.data),
  }
}

function fillCircle(raster: Raster, cx: number, cy: number, radius: number, color: Rgba) {
  const radiusSquared = radius * radius
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= radiusSquared) setPixel(raster, x, y, color)
    }
  }
}

function fillRect(raster: Raster, x: number, y: number, width: number, height: number, color: Rgba) {
  for (let yy = 0; yy < height; yy++) {
    for (let xx = 0; xx < width; xx++) setPixel(raster, x + xx, y + yy, color)
  }
}

function fillTriangle(
  raster: Raster,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  color: Rgba,
) {
  const minX = Math.min(ax, bx, cx)
  const maxX = Math.max(ax, bx, cx)
  const minY = Math.min(ay, by, cy)
  const maxY = Math.max(ay, by, cy)
  const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const alpha = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / denominator
      const beta = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / denominator
      const gamma = 1 - alpha - beta
      if (alpha >= 0 && beta >= 0 && gamma >= 0) setPixel(raster, x, y, color)
    }
  }
}

function fillDiamond(raster: Raster, cx: number, cy: number, radius: number, color: Rgba) {
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (Math.abs(x - cx) + Math.abs(y - cy) <= radius) setPixel(raster, x, y, color)
    }
  }
}

function fillCapsule(
  raster: Raster,
  x: number,
  y: number,
  width: number,
  height: number,
  color: Rgba,
) {
  const radius = height / 2
  const left = x + radius
  const right = x + width - radius
  const cy = y + radius
  for (let yy = y; yy < y + height; yy++) {
    for (let xx = x; xx < x + width; xx++) {
      const closest = xx < left ? left : xx > right ? right : xx
      const dx = xx - closest
      const dy = yy + 0.5 - cy
      if (dx * dx + dy * dy <= radius * radius) setPixel(raster, xx, yy, color)
    }
  }
}

function paintScene(raster: Raster) {
  fillRect(raster, 0, 0, raster.width, raster.height, [244, 234, 216, 255])
  fillRect(raster, 0, 332, raster.width, raster.height - 332, [214, 184, 138, 255])
  fillRect(raster, 0, 318, raster.width, 16, [176, 146, 108, 255])
  fillRect(raster, 36, 36, 118, 86, [112, 78, 46, 255])
  fillRect(raster, 44, 44, 102, 70, [198, 220, 228, 255])
  fillRect(raster, 92, 44, 6, 70, [112, 78, 46, 255])
  fillRect(raster, 44, 76, 102, 6, [112, 78, 46, 255])
  fillCircle(raster, 620, 86, 26, [92, 64, 48, 255])
  fillCircle(raster, 620, 86, 20, [246, 240, 228, 255])
  fillRect(raster, 617, 72, 4, 18, [92, 64, 48, 255])
}

function tightStamp(source: Raster): { raster: Raster; originX: number; originY: number } {
  let minX = source.width
  let minY = source.height
  let maxX = 0
  let maxY = 0
  let found = false
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      if (source.data[(y * source.width + x) * 4 + 3] === 0) continue
      found = true
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  assert(found, "stamp was empty")
  return {
    raster: cropRaster(source, minX, minY, maxX - minX + 1, maxY - minY + 1),
    originX: minX,
    originY: minY,
  }
}

async function buildDemo() {
  const width = 720
  const height = 460
  const reference = createRaster(width, height)
  paintScene(reference)
  const base = structuredCloneRaster(reference)
  const local = createRaster(width, height)
  const stamps: Raster[] = []
  const placeAt: { x: number; y: number }[] = []

  const draw = (painter: (canvas: Raster) => void, x: number, y: number) => {
    painter(local)
    const tight = tightStamp(local)
    for (let index = 0; index < local.data.length; index++) local.data[index] = 0
    stamps.push(tight.raster)
    placeAt.push({ x: x + tight.originX, y: y + tight.originY })
  }

  draw((canvas) => {
    fillCircle(canvas, 150, 168, 42, [196, 52, 40, 255])
    fillCircle(canvas, 150, 168, 16, [232, 186, 72, 255])
  }, 0, 0)
  draw((canvas) => {
    fillRect(canvas, 300, 150, 132, 74, [36, 78, 150, 255])
    fillRect(canvas, 300, 176, 132, 16, [232, 196, 84, 255])
  }, 0, 0)
  draw((canvas) => {
    fillTriangle(canvas, 500, 300, 610, 300, 555, 196, [42, 140, 86, 255])
  }, 0, 0)
  draw((canvas) => {
    fillDiamond(canvas, 180, 390, 34, [214, 112, 36, 255])
  }, 0, 0)
  draw((canvas) => {
    fillCapsule(canvas, 360, 376, 128, 36, [112, 72, 164, 255])
  }, 0, 0)

  const gap = 28
  const sheetWidth =
    24 + stamps.reduce((sum, stamp) => sum + stamp.width, 0) + gap * (stamps.length - 1) + 24
  const sheetHeight = Math.max(...stamps.map((stamp) => stamp.height)) + 48
  const items = createRaster(sheetWidth, sheetHeight)
  let cursor = 24
  const expected: Expected[] = []
  stamps.forEach((stamp, index) => {
    const destinationY = Math.round((sheetHeight - stamp.height) / 2)
    blitOpaque(items, stamp, cursor, destinationY)
    blitOpaque(reference, stamp, placeAt[index].x, placeAt[index].y)
    expected.push({
      x: placeAt[index].x,
      y: placeAt[index].y,
      width: stamp.width,
      height: stamp.height,
    })
    cursor += stamp.width + gap
  })
  setPixel(items, 2, 2, [0, 0, 0, 255])
  setPixel(items, 3, 2, [0, 0, 0, 255])

  mkdirSync(fixtureDir, { recursive: true })
  writeFileSync(path.join(fixtureDir, "reference.png"), encodePng(reference))
  writeFileSync(path.join(fixtureDir, "base.png"), encodePng(base))
  writeFileSync(path.join(fixtureDir, "items.png"), encodePng(items))
  writeFileSync(path.join(fixtureDir, "opaque.png"), encodePng(createRaster(48, 48, [180, 80, 60, 255])))
  writeFileSync(
    path.join(fixtureDir, "expected.json"),
    JSON.stringify({ count: expected.length, placements: expected }, null, 2),
  )

  const roundTrip = decodePng(encodePng(reference))
  assert(roundTrip.width === reference.width && roundTrip.data[0] === reference.data[0], "png roundtrip")
  const result = await expectPlacements("demo scene", reference, base, items, expected, 6)
  assert(result.ok, "demo")
  assert(result.placements.every((placement: Placement) => placement.scale === 1), "demo sprites are 1:1")
}

async function main() {
  await testRejectionsAndSplit()
  await testExactCrop()
  await testUniqueAssignment()
  await testScaledSprite()
  await testBaseResize()
  await buildDemo()
  console.log("all placement checks passed")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
