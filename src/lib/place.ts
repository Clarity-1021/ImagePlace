import { hasTransparency, resample, type Raster } from "./raster"
import {
  assignSprites,
  MATCH_POOR_MEAN_SAD,
  matchSprites,
  type Candidate,
} from "./match-sprites"
import { splitSprites, type Sprite } from "./split-sprites"

export type PlaceProgress =
  | { phase: "split" }
  | { phase: "match"; index: number; total: number }

export type Placement = {
  x: number
  y: number
  width: number
  height: number
  scale: number
  meanSad: number
  uncertain: boolean
}

export type PlaceSuccess = {
  ok: true
  sprites: Sprite[]
  placements: Placement[]
  fittedBase: Raster
  sizeAdjusted: boolean
  truncated: boolean
}

export type PlaceFailure = {
  ok: false
  code: "no-alpha" | "no-items"
}

export type PlaceResult = PlaceSuccess | PlaceFailure

export async function placeItems(
  reference: Raster,
  base: Raster,
  items: Raster,
  hooks?: {
    onProgress?: (progress: PlaceProgress) => void
    yield?: () => Promise<void>
  },
): Promise<PlaceResult> {
  if (!hasTransparency(items)) return { ok: false, code: "no-alpha" }
  hooks?.onProgress?.({ phase: "split" })
  if (hooks?.yield) await hooks.yield()
  const split = splitSprites(items)
  if (split.sprites.length === 0) return { ok: false, code: "no-items" }

  const sizeAdjusted =
    base.width !== reference.width || base.height !== reference.height
  const fittedBase = sizeAdjusted
    ? resample(base, reference.width, reference.height)
    : base

  const matched = await matchSprites(reference, fittedBase, split.sprites, {
    onSprite: (index, total) => {
      hooks?.onProgress?.({ phase: "match", index, total })
    },
    yield: hooks?.yield,
  })
  const assigned = assignSprites(matched)
  const placements = assigned.map((candidate, index) =>
    toPlacement(candidate, split.sprites[index], reference),
  )
  return {
    ok: true,
    sprites: split.sprites,
    placements,
    fittedBase,
    sizeAdjusted,
    truncated: split.truncated,
  }
}

function toPlacement(
  candidate: Candidate | null,
  sprite: Sprite,
  reference: Raster,
): Placement {
  if (!candidate) {
    const fit = Math.min(
      1,
      (reference.width * 0.45) / sprite.width,
      (reference.height * 0.45) / sprite.height,
    )
    return {
      x: 8,
      y: 8,
      width: Math.max(2, Math.round(sprite.width * fit)),
      height: Math.max(2, Math.round(sprite.height * fit)),
      scale: fit,
      meanSad: 999,
      uncertain: true,
    }
  }
  return {
    x: candidate.x,
    y: candidate.y,
    width: candidate.width,
    height: candidate.height,
    scale: candidate.scale,
    meanSad: candidate.meanSad,
    uncertain: candidate.meanSad > MATCH_POOR_MEAN_SAD,
  }
}
