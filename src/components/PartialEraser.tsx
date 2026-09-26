import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CaptureUpdateAction, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { eraseAt } from '../partialEraser'

const CUSTOM_TOOL = 'agentcanvas-partial-eraser'

export function PartialEraser({ api }: { api: ExcalidrawImperativeAPI | null }) {
  const [active, setActive] = useState(false)
  const [size, setSize] = useState(16)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const last = useRef<{ x: number; y: number } | null>(null)
  const before = useRef<ReturnType<ExcalidrawImperativeAPI['getSceneElementsIncludingDeleted']> | null>(null)
  const pointer = useRef<number | null>(null)

  // Excalidraw 0.18 has no toolbar slot. Keep the DOM integration in this
  // adapter; a React portal owns the button, and responsive remounts rebind it.
  useLayoutEffect(() => {
    const root = anchor.current?.parentElement
    if (!root) return
    let mount: HTMLElement | null = null
    const attach = () => {
      const eraser = root.querySelector('[data-testid="toolbar-eraser"]')?.closest('label')
      if (!eraser?.parentElement || (mount?.isConnected && mount.previousElementSibling === eraser)) return
      mount?.remove()
      mount = document.createElement('div')
      mount.className = 'partial-eraser-slot'
      eraser.after(mount)
      setHost(mount)
    }
    attach()
    const observer = new MutationObserver(attach)
    observer.observe(root, { childList: true, subtree: true })
    return () => { observer.disconnect(); mount?.remove() }
  }, [api])

  const finish = () => {
    if (last.current && api && before.current) {
      const after = api.getSceneElementsIncludingDeleted()
      // API history excludes already visible EVENTUALLY edits; restore the
      // baseline before committing the entire drag as a single undo action.
      api.updateScene({ elements: before.current, captureUpdate: CaptureUpdateAction.EVENTUALLY })
      api.updateScene({ elements: after, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
    }
    before.current = null
    last.current = null
    pointer.current = null
  }

  useEffect(() => api?.onChange((_elements, state) => {
    const selected = state.activeTool.type === 'custom' && state.activeTool.customType === CUSTOM_TOOL
    setActive(selected)
  }), [api])

  useEffect(() => {
    const root = anchor.current?.parentElement
    if (!root || !api || !active) return
    root.classList.add('partial-eraser-active')
    const erase = (x: number, y: number) => {
      const state = api.getAppState()
      const point = viewportCoordsToSceneCoords({ clientX: x, clientY: y }, state)
      const radius = size / 2 / state.zoom.value
      const from = last.current ?? point
      const count = Math.max(1, Math.ceil(Math.hypot(point.x - from.x, point.y - from.y) / (radius / 2)))
      const original = api.getSceneElementsIncludingDeleted()
      let elements: Parameters<typeof eraseAt>[0] = original
      for (let i = 1; i <= count; i++) {
        elements = eraseAt(elements, { x: from.x + (point.x - from.x) * i / count, y: from.y + (point.y - from.y) * i / count }, radius)
      }
      if (elements !== original) api.updateScene({ elements, captureUpdate: CaptureUpdateAction.EVENTUALLY })
      last.current = point
    }
    const canvasTarget = (event: PointerEvent) => event.target instanceof HTMLCanvasElement
    const down = (event: PointerEvent) => {
      if (!canvasTarget(event) || event.button !== 0 || pointer.current !== null) return
      event.preventDefault(); event.stopImmediatePropagation()
      pointer.current = event.pointerId
      root.setPointerCapture(event.pointerId)
      root.querySelector<HTMLElement>('.excalidraw')?.focus()
      before.current = api.getSceneElementsIncludingDeleted()
      setCursor({ x: event.clientX, y: event.clientY })
      erase(event.clientX, event.clientY)
    }
    const move = (event: PointerEvent) => {
      const dragging = pointer.current === event.pointerId
      setCursor(dragging || canvasTarget(event) ? { x: event.clientX, y: event.clientY } : null)
      if (!dragging) return
      event.preventDefault(); event.stopImmediatePropagation()
      erase(event.clientX, event.clientY)
    }
    const up = (event: PointerEvent) => {
      if (pointer.current !== event.pointerId) return
      event.preventDefault(); event.stopImmediatePropagation()
      finish()
      if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { finish(); api.setActiveTool({ type: 'selection' }) }
    }
    root.addEventListener('pointerdown', down, true)
    root.addEventListener('pointermove', move, true)
    root.addEventListener('pointerup', up, true)
    root.addEventListener('pointercancel', up, true)
    root.addEventListener('lostpointercapture', up, true)
    window.addEventListener('keydown', escape)
    return () => {
      finish(); setCursor(null)
      root.classList.remove('partial-eraser-active')
      root.removeEventListener('pointerdown', down, true)
      root.removeEventListener('pointermove', move, true)
      root.removeEventListener('pointerup', up, true)
      root.removeEventListener('pointercancel', up, true)
      root.removeEventListener('lostpointercapture', up, true)
      window.removeEventListener('keydown', escape)
    }
  }, [api, active, size])

  return <>
    <span ref={anchor} hidden />
    {host && createPortal(<>
      <button type="button" className="partial-eraser-button ToolIcon__icon" aria-label="局部橡皮擦"
        aria-pressed={active} aria-expanded={active} title="局部橡皮擦（仅手写笔迹）"
        onClick={() => {
          finish()
          api?.setActiveTool(active ? { type: 'selection' } : { type: 'custom', customType: CUSTOM_TOOL })
          anchor.current?.parentElement?.querySelector<HTMLElement>('.excalidraw')?.focus()
        }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="m4 14 8-9a2 2 0 0 1 3 0l5 4a2 2 0 0 1 0 3l-6 7H9zM9 9l8 7M4 21h4m3 0h3m3 0h3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {active && <div className="partial-eraser-options" role="group" aria-label="局部橡皮擦设置">
        <label>直径 <select aria-label="橡皮擦直径" value={size} onChange={(e) => setSize(Number(e.target.value))}>
          <option value={8}>小</option><option value={16}>中</option><option value={32}>大</option>
        </select></label>
        <span>仅手写 · Esc 退出</span>
      </div>}
    </>, host)}
    {active && cursor && <span className="partial-eraser-cursor" style={{ left: cursor.x, top: cursor.y, width: size, height: size }} />}
  </>
}
