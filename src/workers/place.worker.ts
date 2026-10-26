import { placeItems, type PlaceProgress, type PlaceResult } from "../lib/place"
import type { Raster } from "../lib/raster"

type Packed = Raster

export type WorkerRequest = {
  reference: Packed
  base: Packed
  items: Packed
}

export type WorkerResponse =
  | { type: "progress"; progress: PlaceProgress }
  | { type: "done"; result: PlaceResult }
  | { type: "error"; message: string }

const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage: (message: WorkerResponse) => void
}

worker.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    const { reference, base, items } = event.data
    const result = await placeItems(reference, base, items, {
      onProgress: (progress) => {
        const message: WorkerResponse = { type: "progress", progress }
        worker.postMessage(message)
      },
      yield: () => new Promise((resolve) => setTimeout(resolve, 0)),
    })
    const done: WorkerResponse = { type: "done", result }
    worker.postMessage(done)
  } catch (error) {
    const message = error instanceof Error ? error.message : "处理图片时出错"
    const failure: WorkerResponse = { type: "error", message }
    worker.postMessage(failure)
  }
}
