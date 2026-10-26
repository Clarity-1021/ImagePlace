import {
  differenceMask,
  dilateMask,
  downsampleLongSide,
  resample,
  type Raster,
} from "./raster"
import type { Sprite } from "./split-sprites"

const COARSE_LONG_SIDE = 480
const COARSE_STRIDE = 4
const COARSE_SAMPLES = 320
const REFINE_SAMPLES = 2200
const OPAQUE_ALPHA = 140
const HOLE_WEIGHT = 0.45
const POOR_MEAN_SAD = 22
const EXTRA_SCALES = [0.5, 0.75, 1.25, 1.5]

export type Candidate = {
  x: number
  y: number
  width: number
  height: number
  scale: number
  meanSad: number
  score: number
}

type SampleSet = {
  dx: Int16Array
  dy: Int16Array
  r: Uint8Array
  g: Uint8Array
  b: Uint8Array
  count: number
  destWidth: number
  destHeight: number
}

const scratch = { meanSad: 0, holeFrac: 0, score: 0 }

export async function matchSprites(
  reference: Raster,
  base: Raster,
  sprites: Sprite[],
  hooks?: {
    onSprite?: (index: number, total: number) => void
    yield?: () => Promise<void>
  },
): Promise<Candidate[][]> {
  const coarse = downsampleLongSide(reference, COARSE_LONG_SIDE)
  const coarseBase = resample(base, coarse.image.width, coarse.image.height)
  const fullMask = dilateMask(
    differenceMask(reference, base),
    reference.width,
    reference.height,
    2,
  )
  const coarseMask = dilateMask(
    differenceMask(coarse.image, coarseBase),
    coarse.image.width,
    coarse.image.height,
    1,
  )
  const lists: Candidate[][] = []
  for (let index = 0; index < sprites.length; index++) {
    hooks?.onSprite?.(index + 1, sprites.length)
    lists.push(
      candidatesForSprite(
        sprites[index],
        reference,
        fullMask,
        coarse.image,
        coarseMask,
        coarse.scaleX,
        coarse.scaleY,
      ),
    )
    if (hooks?.yield) await hooks.yield()
  }
  return lists
}

function candidatesForSprite(
  sprite: Sprite,
  reference: Raster,
  fullMask: Uint8Array,
  coarse: Raster,
  coarseMask: Uint8Array,
  coarseScaleX: number,
  coarseScaleY: number,
): Candidate[] {
  let pool = refineScale(
    sprite,
    1,
    reference,
    fullMask,
    coarse,
    coarseMask,
    coarseScaleX,
    coarseScaleY,
  )
  pool.sort((left, right) => left.score - right.score || left.meanSad - right.meanSad)
  const best = pool[0]
  if (!best || best.meanSad > POOR_MEAN_SAD) {
    for (const scale of EXTRA_SCALES) {
      pool = pool.concat(
        refineScale(
          sprite,
          scale,
          reference,
          fullMask,
          coarse,
          coarseMask,
          coarseScaleX,
          coarseScaleY,
        ),
      )
    }
  }
  pool.sort((left, right) => left.score - right.score || left.meanSad - right.meanSad)
  const unique: Candidate[] = []
  for (const candidate of pool) {
    const duplicate = unique.some(
      (kept) =>
        kept.scale === candidate.scale &&
        Math.abs(kept.x - candidate.x) <= 2 &&
        Math.abs(kept.y - candidate.y) <= 2,
    )
    if (!duplicate) unique.push(candidate)
    if (unique.length >= 12) break
  }
  return unique
}

function refineScale(
  sprite: Sprite,
  scale: number,
  reference: Raster,
  fullMask: Uint8Array,
  coarse: Raster,
  coarseMask: Uint8Array,
  coarseScaleX: number,
  coarseScaleY: number,
): Candidate[] {
  const fullWidth = Math.round(sprite.width * scale)
  const fullHeight = Math.round(sprite.height * scale)
  if (fullWidth < 2 || fullHeight < 2) return []
  if (fullWidth > reference.width || fullHeight > reference.height) return []

  const coarseHits = searchTranslations(
    sprite,
    scale * coarseScaleX,
    scale * coarseScaleY,
    coarse,
    coarseMask,
    COARSE_STRIDE,
    COARSE_SAMPLES,
    8,
  )
  const windowX = Math.ceil(COARSE_STRIDE / coarseScaleX) + 6
  const windowY = Math.ceil(COARSE_STRIDE / coarseScaleY) + 6
  const refined: Candidate[] = []
  for (const hit of coarseHits) {
    const originX = hit.x / coarseScaleX
    const originY = hit.y / coarseScaleY
    const best = searchWindow(
      sprite,
      scale,
      reference,
      fullMask,
      Math.round(originX),
      Math.round(originY),
      windowX,
      windowY,
    )
    if (best) refined.push(best)
  }
  return refined
}

function searchWindow(
  sprite: Sprite,
  scale: number,
  reference: Raster,
  mask: Uint8Array,
  originX: number,
  originY: number,
  windowX: number,
  windowY: number,
): Candidate | null {
  const sample = buildSamples(sprite, scale, scale, REFINE_SAMPLES)
  if (!sample) return null
  const x0 = Math.max(0, originX - windowX)
  const y0 = Math.max(0, originY - windowY)
  const x1 = Math.min(
    reference.width - sample.destWidth,
    originX + windowX,
  )
  const y1 = Math.min(
    reference.height - sample.destHeight,
    originY + windowY,
  )
  if (x1 < x0 || y1 < y0) return null
  let bestScore = Number.POSITIVE_INFINITY
  let bestX = x0
  let bestY = y0
  let bestSad = Number.POSITIVE_INFINITY
  const stride = windowX > 18 || windowY > 18 ? 2 : 1
  for (let y = y0; y <= y1; y += stride) {
    for (let x = x0; x <= x1; x += stride) {
      if (!scoreAt(reference, mask, sample, x, y, bestScore, true)) continue
      bestScore = scratch.score
      bestSad = scratch.meanSad
      bestX = x
      bestY = y
    }
  }
  if (!Number.isFinite(bestScore)) return null
  if (stride > 1) {
    const left = Math.max(x0, bestX - stride)
    const top = Math.max(y0, bestY - stride)
    const right = Math.min(x1, bestX + stride)
    const bottom = Math.min(y1, bestY + stride)
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        if (!scoreAt(reference, mask, sample, x, y, bestScore, true)) continue
        bestScore = scratch.score
        bestSad = scratch.meanSad
        bestX = x
        bestY = y
      }
    }
  }
  return {
    x: bestX,
    y: bestY,
    width: sample.destWidth,
    height: sample.destHeight,
    scale,
    meanSad: bestSad,
    score: bestScore,
  }
}

function searchTranslations(
  sprite: Sprite,
  scaleX: number,
  scaleY: number,
  reference: Raster,
  mask: Uint8Array,
  stride: number,
  maxSamples: number,
  limit: number,
): { x: number; y: number }[] {
  const sample = buildSamples(sprite, scaleX, scaleY, maxSamples)
  if (!sample) return []
  if (
    sample.destWidth > reference.width ||
    sample.destHeight > reference.height
  ) {
    return []
  }
  const cellWidth = Math.max(stride * 2, Math.round(sample.destWidth * 0.45))
  const cellHeight = Math.max(stride * 2, Math.round(sample.destHeight * 0.45))
  const columns = Math.max(1, Math.ceil(reference.width / cellWidth))
  const rows = Math.max(1, Math.ceil(reference.height / cellHeight))
  const cellScore = new Float64Array(columns * rows).fill(Number.POSITIVE_INFINITY)
  const cellX = new Int32Array(columns * rows)
  const cellY = new Int32Array(columns * rows)
  for (let y = 0; y <= reference.height - sample.destHeight; y += stride) {
    for (let x = 0; x <= reference.width - sample.destWidth; x += stride) {
      // Coarse scan must keep near misses. An exact hit can sit between
      // stride samples, and pruning against a perfect score would drop it.
      if (!scoreAt(reference, mask, sample, x, y, Number.POSITIVE_INFINITY, false)) {
        continue
      }
      const column = Math.min(
        columns - 1,
        Math.floor((x + sample.destWidth / 2) / cellWidth),
      )
      const row = Math.min(
        rows - 1,
        Math.floor((y + sample.destHeight / 2) / cellHeight),
      )
      const cell = row * columns + column
      if (scratch.score < cellScore[cell]) {
        cellScore[cell] = scratch.score
        cellX[cell] = x
        cellY[cell] = y
      }
    }
  }

  const hits: { x: number; y: number; score: number }[] = []
  for (let index = 0; index < cellScore.length; index++) {
    if (Number.isFinite(cellScore[index])) {
      hits.push({ x: cellX[index], y: cellY[index], score: cellScore[index] })
    }
  }
  hits.sort((left, right) => left.score - right.score)
  return hits.slice(0, limit)
}

function scoreAt(
  reference: Raster,
  mask: Uint8Array,
  sample: SampleSet,
  originX: number,
  originY: number,
  bestScore: number,
  prune: boolean,
): boolean {
  const { dx, dy, r, g, b, count } = sample
  const data = reference.data
  const width = reference.width
  const height = reference.height
  let sad = 0
  let holes = 0
  const scoreFloor = 1 - HOLE_WEIGHT
  for (let index = 0; index < count; index++) {
    const x = originX + dx[index]
    const y = originY + dy[index]
    if (x < 0 || y < 0 || x >= width || y >= height) return false
    const pixel = (y * width + x) * 4
    const deltaR = data[pixel] - r[index]
    const deltaG = data[pixel + 1] - g[index]
    const deltaB = data[pixel + 2] - b[index]
    sad += (deltaR < 0 ? -deltaR : deltaR) + (deltaG < 0 ? -deltaG : deltaG) + (deltaB < 0 ? -deltaB : deltaB)
    holes += mask[y * width + x]
    if (prune && index > 24 && sad * scoreFloor > bestScore * count) return false
  }
  const meanSad = sad / count
  const holeFrac = holes / count
  scratch.meanSad = meanSad
  scratch.holeFrac = holeFrac
  scratch.score = meanSad * (1 - HOLE_WEIGHT * holeFrac)
  return true
}

function buildSamples(
  sprite: Raster,
  scaleX: number,
  scaleY: number,
  maxSamples: number,
): SampleSet | null {
  const destWidth = Math.max(1, Math.round(sprite.width * scaleX))
  const destHeight = Math.max(1, Math.round(sprite.height * scaleY))
  if (destWidth < 2 || destHeight < 2) return null
  const opaque = new Uint8Array(destWidth * destHeight)
  for (let y = 0; y < destHeight; y++) {
    const sampleY = Math.min(
      sprite.height - 1,
      Math.max(0, Math.round((y + 0.5) / scaleY - 0.5)),
    )
    for (let x = 0; x < destWidth; x++) {
      const sampleX = Math.min(
        sprite.width - 1,
        Math.max(0, Math.round((x + 0.5) / scaleX - 0.5)),
      )
      const pixel = (sampleY * sprite.width + sampleX) * 4
      if (sprite.data[pixel + 3] >= OPAQUE_ALPHA) opaque[y * destWidth + x] = 1
    }
  }

  const edges: number[] = []
  const interiors: number[] = []
  for (let y = 0; y < destHeight; y++) {
    for (let x = 0; x < destWidth; x++) {
      const index = y * destWidth + x
      if (!opaque[index]) continue
      const onBorder =
        x === 0 ||
        y === 0 ||
        x === destWidth - 1 ||
        y === destHeight - 1 ||
        !opaque[index - 1] ||
        !opaque[index + 1] ||
        (y > 0 && !opaque[index - destWidth]) ||
        (y + 1 < destHeight && !opaque[index + destWidth])
      if (onBorder) edges.push(index)
      else interiors.push(index)
    }
  }
  if (edges.length + interiors.length < 6) return null

  const chosen =
    edges.length >= maxSamples
      ? takeEvenly(edges, maxSamples)
      : edges.concat(takeEvenly(interiors, maxSamples - edges.length))
  const dx = new Int16Array(chosen.length)
  const dy = new Int16Array(chosen.length)
  const r = new Uint8Array(chosen.length)
  const g = new Uint8Array(chosen.length)
  const b = new Uint8Array(chosen.length)
  for (let index = 0; index < chosen.length; index++) {
    const x = chosen[index] % destWidth
    const y = (chosen[index] / destWidth) | 0
    const sampleX = Math.min(
      sprite.width - 1,
      Math.max(0, Math.round((x + 0.5) / scaleX - 0.5)),
    )
    const sampleY = Math.min(
      sprite.height - 1,
      Math.max(0, Math.round((y + 0.5) / scaleY - 0.5)),
    )
    const pixel = (sampleY * sprite.width + sampleX) * 4
    dx[index] = x
    dy[index] = y
    r[index] = sprite.data[pixel]
    g[index] = sprite.data[pixel + 1]
    b[index] = sprite.data[pixel + 2]
  }
  return { dx, dy, r, g, b, count: chosen.length, destWidth, destHeight }
}

function takeEvenly(values: number[], limit: number): number[] {
  if (limit <= 0 || values.length === 0) return []
  if (values.length <= limit) return values
  const picked: number[] = []
  for (let index = 0; index < limit; index++) {
    picked.push(values[Math.floor((index * values.length) / limit)])
  }
  return picked
}

export function assignSprites(lists: Candidate[][]): (Candidate | null)[] {
  type Tagged = Candidate & { index: number }
  const pool: Tagged[] = []
  lists.forEach((candidates, index) => {
    for (const candidate of candidates) pool.push({ ...candidate, index })
  })
  pool.sort(
    (left, right) => left.score - right.score || left.meanSad - right.meanSad,
  )
  const taken = new Set<number>()
  const claimed: Candidate[] = []
  const assigned = new Map<number, Candidate>()
  for (const candidate of pool) {
    if (taken.has(candidate.index)) continue
    if (claimed.some((rect) => intersectionOverUnion(rect, candidate) > 0.28)) {
      continue
    }
    taken.add(candidate.index)
    claimed.push(candidate)
    assigned.set(candidate.index, candidate)
  }
  lists.forEach((candidates, index) => {
    if (!assigned.has(index) && candidates[0]) assigned.set(index, candidates[0])
  })
  return lists.map((_, index) => assigned.get(index) ?? null)
}

function intersectionOverUnion(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): number {
  const x1 = Math.max(left.x, right.x)
  const y1 = Math.max(left.y, right.y)
  const x2 = Math.min(left.x + left.width, right.x + right.width)
  const y2 = Math.min(left.y + left.height, right.y + right.height)
  const overlapWidth = x2 - x1
  const overlapHeight = y2 - y1
  if (overlapWidth <= 0 || overlapHeight <= 0) return 0
  const overlap = overlapWidth * overlapHeight
  const union = left.width * left.height + right.width * right.height - overlap
  return union <= 0 ? 0 : overlap / union
}

export const MATCH_POOR_MEAN_SAD = POOR_MEAN_SAD
