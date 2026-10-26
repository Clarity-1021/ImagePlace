import type { Raster } from "@/lib/raster"

const ACCEPTED = new Set(["image/png", "image/webp", "image/jpeg"])
const MAX_LONG_SIDE = 1600

export class ImageReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ImageReadError"
  }
}

export function isAcceptedImage(file: File): boolean {
  if (ACCEPTED.has(file.type)) return true
  return /\.(png|webp|jpe?g)$/i.test(file.name)
}

export async function fileToRaster(file: File): Promise<{
  raster: Raster
  scaledDown: boolean
}> {
  if (!isAcceptedImage(file)) {
    throw new ImageReadError("请上传 PNG、WebP 或 JPEG。")
  }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new ImageReadError("这张图片无法读取，请换一张 PNG、WebP 或 JPEG。")
  }
  const longest = Math.max(bitmap.width, bitmap.height)
  const scale = longest > MAX_LONG_SIDE ? MAX_LONG_SIDE / longest : 1
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context) {
    bitmap.close()
    throw new ImageReadError("浏览器无法读取这张图片。")
  }
  context.clearRect(0, 0, width, height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = "high"
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const image = context.getImageData(0, 0, width, height)
  return {
    raster: { width, height, data: image.data },
    scaledDown: scale < 1,
  }
}

export function rasterToObjectUrl(raster: Raster): Promise<string> {
  const canvas = document.createElement("canvas")
  canvas.width = raster.width
  canvas.height = raster.height
  const context = canvas.getContext("2d")
  if (!context) return Promise.reject(new ImageReadError("无法绘制图片。"))
  const copy = new Uint8ClampedArray(raster.data)
  context.putImageData(new ImageData(copy, raster.width, raster.height), 0, 0)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new ImageReadError("无法导出图片。"))
        return
      }
      resolve(URL.createObjectURL(blob))
    }, "image/png")
  })
}
