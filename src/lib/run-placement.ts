import { placeItems, type PlaceProgress, type PlaceResult } from "./place"
import type { Raster } from "./raster"

export type PlacementJob = {
  done: Promise<PlaceResult>
  cancel: () => void
}

export function startPlacement(
  reference: Raster,
  base: Raster,
  items: Raster,
  onProgress: (progress: PlaceProgress) => void,
): PlacementJob {
  let worker: Worker
  try {
    worker = new Worker(new URL("../workers/place.worker.ts", import.meta.url))
  } catch {
    return runOnMainThread(reference, base, items, onProgress)
  }

  let settled = false
  let rejectPromise: (error: Error) => void = () => {}
  const done = new Promise<PlaceResult>((resolve, reject) => {
    rejectPromise = reject
    worker.onmessage = (event: MessageEvent) => {
      if (settled) return
      const message = event.data as
        | { type: "progress"; progress: PlaceProgress }
        | { type: "done"; result: PlaceResult }
        | { type: "error"; message: string }
      if (message.type === "progress") {
        onProgress(message.progress)
        return
      }
      settled = true
      worker.terminate()
      if (message.type === "done") resolve(message.result)
      else reject(new Error(message.message))
    }
    worker.onerror = () => {
      if (settled) return
      worker.terminate()
      placeItems(reference, base, items, {
        onProgress,
        yield: () => new Promise((resolveYield) => setTimeout(resolveYield, 0)),
      }).then(
        (result) => {
          if (settled) return
          settled = true
          resolve(result)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          reject(error instanceof Error ? error : new Error("处理图片时出错"))
        },
      )
    }
    worker.postMessage({ reference, base, items })
  })

  return {
    done,
    cancel: () => {
      if (settled) return
      settled = true
      worker.terminate()
      rejectPromise(new DOMException("已取消", "AbortError"))
    },
  }
}

function runOnMainThread(
  reference: Raster,
  base: Raster,
  items: Raster,
  onProgress: (progress: PlaceProgress) => void,
): PlacementJob {
  let cancelled = false
  const done = placeItems(reference, base, items, {
    onProgress,
    yield: () => new Promise((resolve) => setTimeout(resolve, 0)),
  }).then((result) => {
    if (cancelled) throw new DOMException("已取消", "AbortError")
    return result
  })
  return {
    done,
    cancel: () => {
      cancelled = true
    },
  }
}
