import { describe, expect, it, vi } from 'vitest'
vi.mock('@excalidraw/excalidraw', () => ({
  newElementWith: (element: object, patch: object) => ({ ...element, ...patch }),
}))
import type { ExcalidrawFreeDrawElement } from '@excalidraw/excalidraw/element/types'
import { completeErasedStrokes, cutStroke, eraseAt } from './partialEraser'

const line = [{ x: 0, y: 0, pressure: 0.2 }, { x: 100, y: 0, pressure: 0.8 }]
const stroke = { id: 'pen', type: 'freedraw', x: 0, y: 0, width: 100, height: 0, angle: 0,
  points: [[0, 0], [100, 0]], pressures: [0.2, 0.8], strokeWidth: 2, simulatePressure: false,
  isDeleted: false, locked: false } as unknown as ExcalidrawFreeDrawElement

describe('partial eraser', () => {
  it('cuts a sparse segment at the circle edges and interpolates pressure', () => {
    const pieces = cutStroke(line, { x: 50, y: 0 }, 10)
    expect(pieces).toHaveLength(2)
    expect(pieces[0].at(-1)?.x).toBeCloseTo(40)
    expect(pieces[1][0].x).toBeCloseTo(60)
    expect(pieces[0].at(-1)?.pressure).toBeCloseTo(0.44)
    expect(pieces[1][0].pressure).toBeCloseTo(0.56)
  })
  it('keeps unrelated strokes untouched and removes fully covered dots', () => {
    expect(eraseAt([stroke], { x: 50, y: 100 }, 10)[0]).toBe(stroke)
    expect(cutStroke([line[0]], { x: 0, y: 0 }, 10)).toEqual([])
    expect(cutStroke(line, { x: 50, y: 0 }, 60)).toEqual([])
  })
  it('creates two independent strokes while retaining the original identity', () => {
    const result = eraseAt([stroke], { x: 50, y: 0 }, 9) as ExcalidrawFreeDrawElement[]
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe(stroke.id)
    expect(result[0].id).not.toBe(result[1].id)
    expect(result[0].points).toEqual([[0, 0], [40, 0]])
    expect(result[1].x).toBe(60)
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
    expect(stroke.isDeleted).toBe(false)
  })
  it('cuts rotated strokes in scene coordinates without shifting the survivors', () => {
    const rotated = { ...stroke, angle: Math.PI / 2 } as ExcalidrawFreeDrawElement
    const result = eraseAt([rotated], { x: 50, y: 0 }, 9) as ExcalidrawFreeDrawElement[]
    expect(result).toHaveLength(2)
    expect(result[0].x).toBeCloseTo(50)
    expect(result[0].y).toBeCloseTo(-50)
    expect(result[1].y).toBeCloseTo(10)
    expect(result[0].angle).toBe(0)
  })
  it('does not modify locked strokes', () => {
    const locked = { ...stroke, locked: true }
    expect(eraseAt([locked], { x: 50, y: 0 }, 10)[0]).toBe(locked)
  })
  it('restores completed fragment caps after upstream loading without touching other strokes', () => {
    const pieces = eraseAt([stroke], { x: 50, y: 0 }, 9) as ExcalidrawFreeDrawElement[]
    const reloaded = pieces.map((p) => ({ ...p, lastCommittedPoint: null }))
    const completed = completeErasedStrokes(reloaded) as ExcalidrawFreeDrawElement[]
    expect(completed[0].lastCommittedPoint).toEqual(completed[0].points.at(-1))
    expect(completeErasedStrokes(completed)).toBe(completed)
    expect(completeErasedStrokes([stroke])[0]).toBe(stroke)
  })
})
