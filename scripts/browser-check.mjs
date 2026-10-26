import { readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import puppeteer from "puppeteer-core"

const root = path.resolve(import.meta.dirname, "..")
const fixtures = path.join(root, "public", "fixtures")
const expected = JSON.parse(readFileSync(path.join(fixtures, "expected.json"), "utf8"))
const shots = "/opt/cursor/artifacts"
await mkdir(shots, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--font-render-hinting=none"],
})

const page = await browser.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(String(error)))
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text())
})

async function upload(slotIndex, file) {
  const inputs = await page.$$('input[type="file"]')
  await inputs[slotIndex].uploadFile(file)
}

async function spriteCount() {
  return page.$$eval('[data-testid="sprite"]', (nodes) => nodes.length)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
await page.goto("http://127.0.0.1:43123", { waitUntil: "networkidle0" })
const title = await page.$eval("h1", (node) => node.textContent)
assert(title?.includes("物品归位"), `unexpected title: ${title}`)

await upload(0, path.join(fixtures, "reference.png"))
await upload(1, path.join(fixtures, "base.png"))
await upload(2, path.join(fixtures, "opaque.png"))
await page.waitForFunction(
  () => document.body.innerText.includes("没有透明背景"),
  { timeout: 15000 },
)
console.log("opaque items image shows the alpha error")

await upload(2, path.join(fixtures, "items.png"))
await page.waitForSelector('[data-testid="sprite"]', { timeout: 20000 })
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid="sprite"]').length === 5,
  { timeout: 20000 },
)
const cards = await page.$$eval('[data-testid="item-card"]', (nodes) =>
  nodes.map((node) => node.innerText.replace(/\s+/g, " ").trim()),
)
assert(cards.length === 5, `expected 5 cards, got ${cards.length}: ${cards.join(" | ")}`)
assert(cards.every((text, index) => text.includes(`物品 ${index + 1}`)), `labels: ${cards.join(" | ")}`)
console.log("item list", cards)

const placed = await page.$$eval('[data-testid="sprite"]', (nodes) =>
  nodes.map((node) => ({
    x: Number(node.getAttribute("data-x")),
    y: Number(node.getAttribute("data-y")),
    w: Number(node.getAttribute("data-w")),
    h: Number(node.getAttribute("data-h")),
  })),
)
const used = new Set()
for (const sprite of placed) {
  let best = -1
  let bestDistance = Infinity
  expected.placements.forEach((target, index) => {
    if (used.has(index)) return
    const distance = Math.hypot(
      sprite.x + sprite.w / 2 - (target.x + target.width / 2),
      sprite.y + sprite.h / 2 - (target.y + target.height / 2),
    )
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  })
  assert(best >= 0 && bestDistance <= 8, `sprite far from holes: ${JSON.stringify(sprite)} dist=${bestDistance}`)
  used.add(best)
  console.log(`sprite near hole ${best} by ${bestDistance.toFixed(1)}px`, sprite)
}

const checker = await page.$eval('[data-testid="item-card"] .checker', (node) =>
  getComputedStyle(node).backgroundImage,
)
assert(checker.includes("linear-gradient"), `thumbnail has no checkerboard: ${checker}`)

await page.screenshot({ path: path.join(shots, "composite_desktop.png"), fullPage: true })

const hide = await page.$('[data-testid="item-visibility"]')
await hide.click()
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid="sprite"]').length === 4,
)
assert((await hide.evaluate((node) => node.textContent))?.includes("显示"), "hide control should switch to 显示")
console.log("hide removes one overlay, count", await spriteCount())

await hide.click()
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid="sprite"]').length === 5,
)
console.log("show restores the overlay")

await page.click('[data-testid="view-toggle"]')
await page.waitForFunction(
  () => document.querySelector('[data-testid="stage"]')?.getAttribute("data-view") === "reference",
)
assert((await spriteCount()) === 0, "reference view should not draw items")
const referenceLabel = await page.$eval("h1 ~ p, [data-testid='stage']", () => {
  const current = document.body.innerText
  return current.includes("当前画面") && current.includes("参考图")
})
assert(referenceLabel, "reference label missing")
await page.screenshot({ path: path.join(shots, "reference_desktop.png"), fullPage: true })
console.log("reference toggle hides overlays")

await page.click('[data-testid="view-toggle"]')
await page.waitForFunction(
  () => document.querySelector('[data-testid="stage"]')?.getAttribute("data-view") === "composite",
)
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid="sprite"]').length === 5,
)

const sprite = await page.$('[data-testid="sprite"]')
const before = await sprite.evaluate((node) => ({
  x: Number(node.getAttribute("data-x")),
  y: Number(node.getAttribute("data-y")),
}))
const box = await sprite.boundingBox()
assert(box, "sprite has no box")
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await page.mouse.down()
await page.mouse.move(box.x + box.width / 2 + 48, box.y + box.height / 2 + 28, { steps: 8 })
await page.mouse.up()
await page.waitForFunction(
  (originX) => {
    const node = document.querySelector('[data-testid="sprite"]')
    return node && Math.abs(Number(node.getAttribute("data-x")) - originX) > 8
  },
  {},
  before.x,
)
const after = await page.$eval('[data-testid="sprite"][data-index="0"]', (node) => ({
  x: Number(node.getAttribute("data-x")),
  y: Number(node.getAttribute("data-y")),
}))
console.log("drag nudge", before, "->", after)
await page.screenshot({ path: path.join(shots, "composite_after_drag.png"), fullPage: true })

const resize = await page.$('[data-testid="resize-handle"]')
assert(resize, "resize handle missing after drag selection")
await resize.evaluate((node) => node.scrollIntoView({ block: "center", inline: "center" }))
const beforeSize = await page.$eval('[data-testid="sprite"][data-index="0"]', (node) =>
  Number(node.getAttribute("data-w")),
)
const handleBox = await resize.boundingBox()
assert(handleBox, "handle has no box")
await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
await page.mouse.down()
await page.mouse.move(handleBox.x + 36, handleBox.y + 36, { steps: 6 })
await page.mouse.up()
await page.waitForFunction(
  (origin) => {
    const node = document.querySelector('[data-testid="sprite"][data-index="0"]')
    return node && Math.abs(Number(node.getAttribute("data-w")) - origin) > 4
  },
  {},
  beforeSize,
)
const afterSize = await page.$eval('[data-testid="sprite"][data-index="0"]', (node) =>
  Number(node.getAttribute("data-w")),
)
console.log("resize width", beforeSize, "->", afterSize)

await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
await page.waitForFunction(() => document.querySelector("h1"))
const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
)
assert(overflow <= 1, `mobile page overflows by ${overflow}px`)
await page.screenshot({ path: path.join(shots, "mobile_composite.png"), fullPage: true })
console.log("mobile overflow", overflow)

assert(errors.length === 0, `console errors:\n${errors.join("\n")}`)
await browser.close()
console.log("browser checks passed")
