import { expect, it, vi } from 'vitest'
vi.mock('@excalidraw/excalidraw', () => ({ FONT_FAMILY: { Nunito: 6 } }))
import type { AppState } from '@excalidraw/excalidraw/types'
import { createToolStyles, drawingDefaults } from './drawingDefaults'

it('isolates pen width from shapes and remembers manual choices per tool', () => {
  const next = createToolStyles()
  const state = { ...drawingDefaults, activeTool: { type: 'freedraw' } } as AppState
  expect(next(state)?.currentItemStrokeWidth).toBe(1)
  next({ ...state, currentItemStrokeWidth: 4 })
  expect(next({ ...state, activeTool: { type: 'rectangle' } } as AppState)?.currentItemStrokeWidth).toBe(2)
  expect(next(state)?.currentItemStrokeWidth).toBe(4)
})

it('does not apply creation defaults to an existing selection', () => {
  const next = createToolStyles()
  expect(next({ ...drawingDefaults, activeTool: { type: 'selection' } } as AppState)).toBeNull()
})
