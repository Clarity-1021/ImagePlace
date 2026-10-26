import { deflateSync, inflateSync } from "node:zlib"
import type { Raster } from "../src/lib/raster"

const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < 256; index++) {
  let value = index
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  CRC_TABLE[index] = value >>> 0
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index++) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const name = Buffer.from(type)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])), 0)
  return Buffer.concat([length, name, data, checksum])
}

export function encodePng(raster: Raster): Buffer {
  const stride = raster.width * 4
  const raw = Buffer.alloc((stride + 1) * raster.height)
  for (let y = 0; y < raster.height; y++) {
    const row = y * (stride + 1)
    raw[row] = 0
    Buffer.from(
      raster.data.buffer,
      raster.data.byteOffset + y * stride,
      stride,
    ).copy(raw, row + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(raster.width, 0)
  header.writeUInt32BE(raster.height, 4)
  header[8] = 8
  header[9] = 6
  header[10] = 0
  header[11] = 0
  header[12] = 0
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

export function decodePng(buffer: Buffer): Raster {
  let offset = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString("ascii", offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6) {
        throw new Error("Only 8-bit RGBA PNGs are supported")
      }
    } else if (type === "IDAT") {
      idat.push(data)
    } else if (type === "IEND") {
      break
    }
    offset += 12 + length
  }
  const inflated = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const data = new Uint8ClampedArray(width * height * 4)
  let cursor = 0
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = inflated[cursor]
    cursor++
    const row = Buffer.from(inflated.subarray(cursor, cursor + stride))
    cursor += stride
    unfilter(filter, row, previous, stride)
    data.set(row, y * stride)
    previous = row
  }
  return { width, height, data }
}

function unfilter(filter: number, row: Buffer, previous: Buffer, stride: number) {
  for (let index = 0; index < stride; index++) {
    const left = index >= 4 ? row[index - 4] : 0
    const up = previous[index]
    const upLeft = index >= 4 ? previous[index - 4] : 0
    if (filter === 1) row[index] = (row[index] + left) & 255
    else if (filter === 2) row[index] = (row[index] + up) & 255
    else if (filter === 3) row[index] = (row[index] + Math.floor((left + up) / 2)) & 255
    else if (filter === 4) row[index] = (row[index] + paeth(left, up, upLeft)) & 255
  }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const diagonal = Math.abs(estimate - upLeft)
  if (leftDistance <= upDistance && leftDistance <= diagonal) return left
  if (upDistance <= diagonal) return up
  return upLeft
}
