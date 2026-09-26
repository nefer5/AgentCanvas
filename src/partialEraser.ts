import { newElementWith } from '@excalidraw/excalidraw'
import type { ExcalidrawElement, ExcalidrawFreeDrawElement } from '@excalidraw/excalidraw/element/types'

export type PenPoint = { x: number; y: number; pressure: number }

// Analytic circle/segment intersections also catch a crossing between sparse
// pointer samples. Interpolate pressure at the new ends of each stroke.
export function cutStroke(points: PenPoint[], center: { x: number; y: number }, radius: number): PenPoint[][] {
  const outside = (p: PenPoint) => Math.hypot(p.x - center.x, p.y - center.y) > radius
  if (points.length < 2) return points.filter(outside).map((p) => [p])
  const runs: PenPoint[][] = []
  let run: PenPoint[] = []
  const finish = () => { if (run.length) runs.push(run); run = [] }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    const dx = b.x - a.x, dy = b.y - a.y
    const ox = a.x - center.x, oy = a.y - center.y
    const aa = dx * dx + dy * dy
    const bb = 2 * (ox * dx + oy * dy)
    const cc = ox * ox + oy * oy - radius * radius
    const disc = bb * bb - 4 * aa * cc
    const ts = [0, 1]
    if (aa > 0 && disc > 0) {
      for (const t of [(-bb - Math.sqrt(disc)) / (2 * aa), (-bb + Math.sqrt(disc)) / (2 * aa)]) {
        if (t > 0 && t < 1) ts.push(t)
      }
    }
    ts.sort((x, y) => x - y)
    const at = (t: number): PenPoint => ({ x: a.x + dx * t, y: a.y + dy * t, pressure: a.pressure + (b.pressure - a.pressure) * t })
    for (let j = 1; j < ts.length; j++) {
      if (outside(at((ts[j - 1] + ts[j]) / 2))) {
        if (!run.length) run.push(at(ts[j - 1]))
        run.push(at(ts[j]))
      } else finish()
    }
  }
  finish()
  return runs
}

function worldPoints(element: ExcalidrawFreeDrawElement): PenPoint[] {
  const xs = element.points.map((p) => p[0]), ys = element.points.map((p) => p[1])
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const cos = Math.cos(element.angle), sin = Math.sin(element.angle)
  return element.points.map(([x, y], i) => ({
    x: element.x + cx + (x - cx) * cos - (y - cy) * sin,
    y: element.y + cy + (x - cx) * sin + (y - cy) * cos,
    pressure: element.pressures[i] ?? 0.5,
  }))
}

export function eraseAt(elements: readonly ExcalidrawElement[], center: { x: number; y: number }, radius: number): readonly ExcalidrawElement[] {
  let changed = false
  const result = elements.flatMap((element): ExcalidrawElement[] => {
    if (element.type !== 'freedraw' || element.isDeleted || element.locked) return [element]
    const points = worldPoints(element)
    const pieces = cutStroke(points, center, radius + element.strokeWidth / 2)
    if (pieces.length === 1 && pieces[0].length === points.length
      && pieces[0].every((p, i) => Math.abs(p.x - points[i].x) < 1e-8 && Math.abs(p.y - points[i].y) < 1e-8)) return [element]
    changed = true
    if (!pieces.length) return [newElementWith(element, { isDeleted: true })]
    return pieces.map((piece, index) => {
      const origin = piece[0]
      const local = piece.map((p) => [p.x - origin.x, p.y - origin.y]) as unknown as ExcalidrawFreeDrawElement['points']
      return {
        ...newElementWith(element, {
          x: origin.x, y: origin.y, angle: 0 as ExcalidrawFreeDrawElement['angle'],
          points: local,
          width: Math.max(...local.map((p) => p[0])) - Math.min(...local.map((p) => p[0])),
          height: Math.max(...local.map((p) => p[1])) - Math.min(...local.map((p) => p[1])),
          pressures: element.simulatePressure ? [] : piece.map((p) => p.pressure),
          lastCommittedPoint: local[local.length - 1],
          customData: { ...element.customData, agentcanvasPartialStroke: true },
        }),
        id: index === 0 ? element.id : crypto.randomUUID(),
        index: index === 0 ? element.index : null,
      }
    })
  })
  return changed ? result : elements
}

// The upstream loader resets lastCommittedPoint even for finished strokes.
// Restore it for our fragments so their end caps do not retract after reload.
export function completeErasedStrokes(elements: readonly ExcalidrawElement[]): readonly ExcalidrawElement[] {
  let changed = false
  const result = elements.map((element) => {
    if (element.type !== 'freedraw' || element.isDeleted || element.lastCommittedPoint
      || !element.customData?.agentcanvasPartialStroke || !element.points.length) return element
    changed = true
    return newElementWith(element, { lastCommittedPoint: element.points[element.points.length - 1] })
  })
  return changed ? result : elements
}
