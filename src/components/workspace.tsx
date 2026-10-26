"use client"

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react"
import { Button } from "@/components/ui/button"
import {
  fileToRaster,
  ImageReadError,
  isAcceptedImage,
  rasterToObjectUrl,
} from "@/lib/browser-image"
import type { PlaceProgress } from "@/lib/place"
import { startPlacement, type PlacementJob } from "@/lib/run-placement"
import { cn } from "@/lib/utils"

type Slot = "reference" | "base" | "items"

type SlotFiles = Record<Slot, File | null>

type ItemState = {
  thumbUrl: string
  visible: boolean
  uncertain: boolean
  x: number
  y: number
  width: number
  height: number
}

type ReadyState = {
  referenceUrl: string
  baseUrl: string
  width: number
  height: number
  items: ItemState[]
  sizeAdjusted: boolean
  scaledDown: boolean
  truncated: boolean
}

type Phase =
  | { kind: "idle" }
  | { kind: "processing"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready" }

const SLOTS: { id: Slot; title: string; hint: string }[] = [
  {
    id: "reference",
    title: "参考图",
    hint: "完整场景，物品都在正确的位置。",
  },
  {
    id: "base",
    title: "底图",
    hint: "同一场景，要放回的物品已经被拿走。",
  },
  {
    id: "items",
    title: "物品图",
    hint: "透明背景，物品彼此分开、互不重叠。",
  },
]

const EMPTY_FILES: SlotFiles = { reference: null, base: null, items: null }

export function Workspace() {
  const [files, setFiles] = useState<SlotFiles>(EMPTY_FILES)
  const [previews, setPreviews] = useState<Record<Slot, string | null>>({
    reference: null,
    base: null,
    items: null,
  })
  const [phase, setPhase] = useState<Phase>({ kind: "idle" })
  const [ready, setReady] = useState<ReadyState | null>(null)
  const [view, setView] = useState<"composite" | "reference">("composite")
  const [selected, setSelected] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<Slot | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const sizeRef = useRef({ w: 1, h: 1 })
  const dragRef = useRef<DragState | null>(null)
  const jobRef = useRef<PlacementJob | null>(null)
  const runRef = useRef(0)
  const urlsRef = useRef<string[]>([])
  const filesRef = useRef<SlotFiles>(EMPTY_FILES)

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current
      const frame = frameRef.current
      if (!drag || !frame) return
      const rect = frame.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      const { w: sceneWidth, h: sceneHeight } = sizeRef.current
      const deltaX = ((event.clientX - drag.clientX) / rect.width) * sceneWidth
      const deltaY = ((event.clientY - drag.clientY) / rect.height) * sceneHeight
      setReady((current) => {
        if (!current) return current
        return {
          ...current,
          items: current.items.map((item, index) => {
            if (index !== drag.index) return item
            if (drag.mode === "move") {
              return {
                ...item,
                x: clamp(
                  drag.origX + deltaX,
                  -item.width * 0.25,
                  sceneWidth - item.width * 0.75,
                ),
                y: clamp(
                  drag.origY + deltaY,
                  -item.height * 0.25,
                  sceneHeight - item.height * 0.75,
                ),
              }
            }
            const cornerX = drag.origX + drag.origWidth + deltaX
            const cornerY = drag.origY + drag.origHeight + deltaY
            const distance = Math.hypot(cornerX - drag.origX, cornerY - drag.origY)
            const base = Math.hypot(drag.origWidth, drag.origHeight)
            const factor = Math.max(0.15, distance / Math.max(1, base))
            const aspect = drag.origWidth / drag.origHeight
            let width = clamp(drag.origWidth * factor, 16, sceneWidth * 1.25)
            let height = width / aspect
            if (height > sceneHeight * 1.25) {
              height = sceneHeight * 1.25
              width = height * aspect
            }
            return { ...item, width, height }
          }),
        }
      })
    }
    const stop = () => {
      dragRef.current = null
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
      jobRef.current?.cancel()
      for (const url of urlsRef.current) URL.revokeObjectURL(url)
    }
  }, [])

  const missing = SLOTS.filter((slot) => !files[slot.id]).map((slot) => slot.title)

  function rememberUrl(url: string) {
    urlsRef.current.push(url)
    return url
  }

  function releaseResultUrls() {
    for (const url of urlsRef.current) URL.revokeObjectURL(url)
    urlsRef.current = []
  }

  function updatePreview(slot: Slot, file: File) {
    setPreviews((current) => {
      const previous = current[slot]
      if (previous) URL.revokeObjectURL(previous)
      return { ...current, [slot]: URL.createObjectURL(file) }
    })
  }

  async function applyFiles(next: SlotFiles) {
    filesRef.current = next
    setFiles(next)
    setView("composite")
    setSelected(null)
    if (!next.reference || !next.base || !next.items) {
      jobRef.current?.cancel()
      releaseResultUrls()
      setReady(null)
      setPhase({ kind: "idle" })
      return
    }
    await run(next.reference, next.base, next.items)
  }

  async function run(referenceFile: File, baseFile: File, itemsFile: File) {
    const runId = ++runRef.current
    jobRef.current?.cancel()
    setPhase({ kind: "processing", message: "正在读取图片…" })
    setReady(null)
    releaseResultUrls()
    try {
      const [reference, base, items] = await Promise.all([
        fileToRaster(referenceFile),
        fileToRaster(baseFile),
        fileToRaster(itemsFile),
      ])
      if (runId !== runRef.current) return
      const scaledDown =
        reference.scaledDown || base.scaledDown || items.scaledDown
      const job = startPlacement(
        reference.raster,
        base.raster,
        items.raster,
        (progress) => {
          if (runId !== runRef.current) return
          setPhase({ kind: "processing", message: progressText(progress) })
        },
      )
      jobRef.current = job
      const result = await job.done
      if (runId !== runRef.current) return
      if (!result.ok) {
        setPhase({ kind: "error", message: failureText(result.code) })
        return
      }
      const referenceUrl = rememberUrl(await rasterToObjectUrl(reference.raster))
      const baseUrl = rememberUrl(await rasterToObjectUrl(result.fittedBase))
      const itemStates: ItemState[] = []
      for (let index = 0; index < result.sprites.length; index++) {
        const placement = result.placements[index]
        itemStates.push({
          thumbUrl: rememberUrl(await rasterToObjectUrl(result.sprites[index])),
          visible: true,
          uncertain: placement.uncertain,
          x: placement.x,
          y: placement.y,
          width: placement.width,
          height: placement.height,
        })
      }
      if (runId !== runRef.current) return
      sizeRef.current = {
        w: reference.raster.width,
        h: reference.raster.height,
      }
      setReady({
        referenceUrl,
        baseUrl,
        width: reference.raster.width,
        height: reference.raster.height,
        items: itemStates,
        sizeAdjusted: result.sizeAdjusted,
        scaledDown,
        truncated: result.truncated,
      })
      setPhase({ kind: "ready" })
    } catch (error) {
      if (runId !== runRef.current) return
      if (error instanceof DOMException && error.name === "AbortError") return
      const message =
        error instanceof ImageReadError
          ? error.message
          : error instanceof Error
            ? error.message
            : "处理图片时出错。"
      setPhase({ kind: "error", message })
    }
  }

  function onPick(slot: Slot, file: File | null) {
    if (!file) return
    if (!isAcceptedImage(file)) {
      setPhase({
        kind: "error",
        message: "请上传 PNG、WebP 或 JPEG。",
      })
      return
    }
    updatePreview(slot, file)
    void applyFiles({ ...filesRef.current, [slot]: file })
  }

  async function loadSample() {
    setPhase({ kind: "processing", message: "正在读取示例…" })
    try {
      const load = async (name: string) => {
        const response = await fetch(`/fixtures/${name}.png`)
        if (!response.ok) throw new ImageReadError("示例图片加载失败。")
        const blob = await response.blob()
        return new File([blob], `${name}.png`, { type: "image/png" })
      }
      const reference = await load("reference")
      const base = await load("base")
      const items = await load("items")
      updatePreview("reference", reference)
      updatePreview("base", base)
      updatePreview("items", items)
      await applyFiles({ reference, base, items })
    } catch (error) {
      const message =
        error instanceof ImageReadError ? error.message : "示例图片加载失败。"
      setPhase({ kind: "error", message })
    }
  }

  function beginDrag(
    event: ReactPointerEvent<HTMLElement>,
    index: number,
    mode: "move" | "resize",
  ) {
    if (!ready || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const item = ready.items[index]
    dragRef.current = {
      mode,
      index,
      clientX: event.clientX,
      clientY: event.clientY,
      origX: item.x,
      origY: item.y,
      origWidth: item.width,
      origHeight: item.height,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setSelected(index)
  }

  const uncertainCount = ready?.items.filter((item) => item.uncertain).length ?? 0

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <p className="text-sm text-muted-foreground">全部在浏览器里完成，图片不会上传</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">物品归位</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground sm:text-base">
            对照参考图，把散开的物品放回底图原来的位置。放好之后可以逐件显示或隐藏，并和参考图来回核对。
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => void loadSample()}>
          载入示例
        </Button>
      </header>

      <section className="grid gap-3 md:grid-cols-3">
        {SLOTS.map((slot) => (
          <UploadCard
            key={slot.id}
            title={slot.title}
            hint={slot.hint}
            checker={slot.id === "items"}
            preview={previews[slot.id]}
            fileName={files[slot.id]?.name ?? null}
            dragging={dragOver === slot.id}
            onDragState={(active) => setDragOver(active ? slot.id : null)}
            onFile={(file) => onPick(slot.id, file)}
          />
        ))}
      </section>

      <section className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
          {phase.kind === "ready" && ready ? (
            <Stage
              ready={ready}
              view={view}
              selected={selected}
              frameRef={frameRef}
              uncertainCount={uncertainCount}
              onToggleView={() => {
                setView((current) =>
                  current === "composite" ? "reference" : "composite",
                )
                setSelected(null)
              }}
              onSelect={(index) => setSelected(index)}
              onClearSelection={() => setSelected(null)}
              onDrag={beginDrag}
            />
          ) : (
            <StatusPanel
              phase={phase}
              missing={missing}
              onLoadSample={() => void loadSample()}
            />
          )}
        </div>
        <ItemBar
          items={ready?.items ?? []}
          selected={selected}
          onSelect={setSelected}
          onToggleVisible={(index) => {
            setReady((current) => {
              if (!current) return current
              return {
                ...current,
                items: current.items.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, visible: !item.visible } : item,
                ),
              }
            })
          }}
        />
      </section>
    </div>
  )
}

function UploadCard({
  title,
  hint,
  checker,
  preview,
  fileName,
  dragging,
  onDragState,
  onFile,
}: {
  title: string
  hint: string
  checker: boolean
  preview: string | null
  fileName: string | null
  dragging: boolean
  onDragState: (active: boolean) => void
  onFile: (file: File | null) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <article className="flex flex-col rounded-2xl border bg-card p-3 shadow-sm">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-medium">{title}</h2>
        {fileName ? (
          <span className="max-w-[10rem] truncate text-xs text-muted-foreground">
            {fileName}
          </span>
        ) : null}
      </div>
      <p className="mt-1 min-h-10 text-xs leading-5 text-muted-foreground">{hint}</p>
      <div
        className={cn(
          "mt-2 flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl border border-dashed",
          checker ? "checker" : "bg-muted",
          dragging && "border-primary ring-2 ring-primary/30",
        )}
        onDragOver={(event) => {
          event.preventDefault()
          onDragState(true)
        }}
        onDragLeave={() => onDragState(false)}
        onDrop={(event) => {
          event.preventDefault()
          onDragState(false)
          onFile(event.dataTransfer.files?.[0] ?? null)
        }}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="" className="max-h-full max-w-full object-contain" />
        ) : (
          <p className="px-4 text-center text-xs leading-5 text-muted-foreground">
            拖到这里，或选择 PNG、WebP、JPEG
          </p>
        )}
      </div>
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        accept="image/png,image/webp,image/jpeg"
        onChange={(event) => {
          onFile(event.target.files?.[0] ?? null)
          event.target.value = ""
        }}
      />
      <Button
        type="button"
        variant="outline"
        className="mt-3 w-full"
        onClick={() => inputRef.current?.click()}
      >
        {preview ? "重新选择" : "选择图片"}
      </Button>
    </article>
  )
}

function StatusPanel({
  phase,
  missing,
  onLoadSample,
}: {
  phase: Phase
  missing: string[]
  onLoadSample: () => void
}) {
  if (phase.kind === "processing") {
    return (
      <div className="flex min-h-72 flex-col justify-center gap-3 px-2 py-8" aria-live="polite">
        <p className="text-lg font-medium">正在处理</p>
        <p className="text-sm text-muted-foreground">{phase.message}</p>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
        </div>
      </div>
    )
  }
  if (phase.kind === "error") {
    return (
      <div className="flex min-h-72 flex-col justify-center gap-2 px-2 py-8" role="alert">
        <p className="text-lg font-medium">没法继续叠放</p>
        <p className="max-w-xl text-sm leading-6 text-muted-foreground">{phase.message}</p>
      </div>
    )
  }
  return (
    <div className="flex min-h-72 flex-col justify-center gap-3 px-2 py-8">
      <p className="text-lg font-medium">
        {missing.length === 3 ? "先上传三张图" : `还差${missing.join("、")}`}
      </p>
      <ul className="max-w-xl list-disc space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
        <li>参考图给出每个物品该在的位置和大小。</li>
        <li>底图是拿走这些物品之后的同一场景。</li>
        <li>物品图用透明背景，把散件分开摆好。</li>
      </ul>
      {missing.length === 3 ? (
        <div>
          <Button type="button" onClick={onLoadSample}>
            载入示例
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function Stage({
  ready,
  view,
  selected,
  frameRef,
  uncertainCount,
  onToggleView,
  onSelect,
  onClearSelection,
  onDrag,
}: {
  ready: ReadyState
  view: "composite" | "reference"
  selected: number | null
  frameRef: RefObject<HTMLDivElement | null>
  uncertainCount: number
  onToggleView: () => void
  onSelect: (index: number) => void
  onClearSelection: () => void
  onDrag: (
    event: ReactPointerEvent<HTMLElement>,
    index: number,
    mode: "move" | "resize",
  ) => void
}) {
  const notes: string[] = []
  if (ready.sizeAdjusted) {
    notes.push("底图和参考图的像素尺寸不一致，已把底图缩放到参考图的尺寸再叠放。")
  }
  if (ready.scaledDown) {
    notes.push("图片较大，已把长边限制在 1600 像素内处理。")
  }
  if (ready.truncated) {
    notes.push("物品较多，只保留了面积最大的 40 个。")
  }
  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs text-muted-foreground">当前画面</p>
          <p className="text-lg font-medium">
            {view === "composite" ? "底图叠放" : "参考图"}
          </p>
        </div>
        <Button type="button" data-testid="view-toggle" onClick={onToggleView}>
          {view === "composite" ? "查看参考图" : "查看底图叠放"}
        </Button>
      </div>
      {notes.length > 0 ? (
        <div className="mt-3 space-y-1">
          {notes.map((note) => (
            <p key={note} className="rounded-lg bg-accent px-3 py-2 text-sm leading-6">
              {note}
            </p>
          ))}
        </div>
      ) : null}
      {uncertainCount > 0 ? (
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          有 {uncertainCount} 件物品匹配不太有把握，已放在最接近的位置。请对照参考图拖动修正。
        </p>
      ) : null}
      <div
        className="mx-auto mt-3 w-full"
        style={{
          maxWidth: `min(100%, calc(72vh * ${ready.width} / ${ready.height}))`,
        }}
      >
        <div
          ref={frameRef}
          data-testid="stage"
          data-view={view}
          className="checker relative w-full select-none overflow-visible rounded-xl border"
          style={{ aspectRatio: `${ready.width} / ${ready.height}` }}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) onClearSelection()
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            data-role="stage-image"
            src={view === "composite" ? ready.baseUrl : ready.referenceUrl}
            alt={view === "composite" ? "底图叠放" : "参考图"}
            className="absolute inset-0 h-full w-full"
            draggable={false}
            onPointerDown={onClearSelection}
          />
          {view === "composite"
            ? ready.items.map((item, index) =>
                item.visible ? (
                  <div
                    key={index}
                    data-testid="sprite"
                    data-index={index}
                    data-x={Math.round(item.x)}
                    data-y={Math.round(item.y)}
                    data-w={Math.round(item.width)}
                    data-h={Math.round(item.height)}
                    className={cn(
                      "absolute touch-none",
                      selected === index ? "z-30 cursor-grabbing" : "z-10 cursor-grab",
                    )}
                    style={{
                      left: `${(item.x / ready.width) * 100}%`,
                      top: `${(item.y / ready.height) * 100}%`,
                      width: `${(item.width / ready.width) * 100}%`,
                      height: `${(item.height / ready.height) * 100}%`,
                    }}
                    onPointerDown={(event) => {
                      onSelect(index)
                      onDrag(event, index, "move")
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.thumbUrl}
                      alt={`物品 ${index + 1}`}
                      draggable={false}
                      className="pointer-events-none h-full w-full"
                    />
                    {selected === index ? (
                      <>
                        <span className="pointer-events-none absolute -top-6 left-0 rounded bg-primary px-1.5 py-0.5 text-[11px] text-primary-foreground">
                          物品 {index + 1}
                        </span>
                        <span className="pointer-events-none absolute inset-0 ring-2 ring-primary" />
                        <div
                          role="slider"
                          aria-label={`调整物品 ${index + 1} 的大小`}
                          aria-valuemin={16}
                          aria-valuenow={Math.round(item.width)}
                          data-testid="resize-handle"
                          className="absolute -right-1.5 -bottom-1.5 z-10 size-4 cursor-nwse-resize rounded-sm border border-primary-foreground bg-primary shadow"
                          onPointerDown={(event) => onDrag(event, index, "resize")}
                        />
                      </>
                    ) : null}
                  </div>
                ) : null,
              )
            : null}
        </div>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        在底图叠放上拖动物品可微调位置，拖动右下角可调整大小。隐藏后，该物品会从叠放结果里消失；参考图始终是原图。
      </p>
    </div>
  )
}

function ItemBar({
  items,
  selected,
  onSelect,
  onToggleVisible,
}: {
  items: ItemState[]
  selected: number | null
  onSelect: (index: number) => void
  onToggleVisible: (index: number) => void
}) {
  return (
    <aside className="min-w-0 rounded-2xl border bg-card p-3 shadow-sm">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-medium">物品</h2>
        <span className="text-xs text-muted-foreground">
          {items.length > 0 ? `共 ${items.length} 件` : "还没有物品"}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          分离完成后，每件物品会出现在这里。缩略图下面的格子用来看出透明背景。
        </p>
      ) : (
        <ul className="mt-3 flex max-w-full gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
          {items.map((item, index) => (
            <li
              key={index}
              data-testid="item-card"
              className={cn(
                "flex w-56 shrink-0 items-center gap-3 rounded-xl border p-2 lg:w-auto lg:shrink",
                !item.visible && "opacity-60",
                selected === index && "ring-2 ring-primary",
              )}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                onClick={() => onSelect(index)}
              >
                <span className="checker size-14 shrink-0 overflow-hidden rounded-md">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.thumbUrl}
                    alt=""
                    className="size-full object-contain"
                  />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">物品 {index + 1}</span>
                  {item.uncertain ? (
                    <span className="block text-xs text-muted-foreground">待核对</span>
                  ) : (
                    <span className="block text-xs text-muted-foreground">
                      {item.visible ? "显示在底图上" : "已从底图隐藏"}
                    </span>
                  )}
                </span>
              </button>
              <Button
                type="button"
                size="sm"
                variant={item.visible ? "outline" : "secondary"}
                data-testid="item-visibility"
                aria-pressed={item.visible}
                onClick={() => onToggleVisible(index)}
              >
                {item.visible ? "隐藏" : "显示"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}

function progressText(progress: PlaceProgress): string {
  if (progress.phase === "split") return "正在从物品图里分离每一件…"
  return `正在对照参考图定位（${progress.index} / ${progress.total}）…`
}

function failureText(code: "no-alpha" | "no-items"): string {
  if (code === "no-alpha") {
    return "物品图没有透明背景，没法把物品分开。请换一张背景透明的 PNG 或 WebP。JPEG 不包含透明通道。"
  }
  return "没有分离出可用的物品。请确认背景透明、物品互相分开，且不要只剩细小噪点。"
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

type DragState = {
  mode: "move" | "resize"
  index: number
  clientX: number
  clientY: number
  origX: number
  origY: number
  origWidth: number
  origHeight: number
}
