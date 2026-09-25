import { convertToExcalidrawElements, restoreLibraryItems } from '@excalidraw/excalidraw'
import type { LibraryItems } from '@excalidraw/excalidraw/types'
import type { ExcalidrawLinearElement } from '@excalidraw/excalidraw/element/types'

export const LIBRARY_KEY = 'agentcanvas-library-v1'
const triangles = [
  { id: 'equilateral', name: '等边三角形', points: [[0, 104], [60, 0], [120, 104], [0, 104]] },
  { id: 'isosceles', name: '等腰三角形', points: [[0, 140], [50, 0], [100, 140], [0, 140]] },
  { id: 'right', name: '直角三角形', points: [[0, 0], [0, 100], [140, 100], [0, 0]] },
  { id: 'right-isosceles', name: '等腰直角三角形', points: [[0, 0], [0, 100], [100, 100], [0, 0]] },
  { id: 'inverted', name: '倒三角形', points: [[0, 0], [120, 0], [60, 104], [0, 0]] },
  { id: 'scalene', name: '不等边三角形', points: [[0, 100], [35, 0], [150, 100], [0, 100]] },
]

export function defaultLibrary(): LibraryItems {
  return restoreLibraryItems(triangles.map(({ id, name, points }) => ({
    id: `agentcanvas-triangle-${id}-v1`,
    name,
    status: 'unpublished',
    created: 0,
    elements: convertToExcalidrawElements([{
      type: 'line', x: 0, y: 0,
      points: points as ExcalidrawLinearElement['points'],
      roughness: 0, roundness: null, strokeWidth: 2,
      strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
      startArrowhead: null, endArrowhead: null,
    }]),
  })), 'unpublished')
}

export function loadLibrary(): LibraryItems {
  try {
    const saved = window.localStorage.getItem(LIBRARY_KEY)
    if (saved) return restoreLibraryItems(JSON.parse(saved), 'unpublished')
  } catch { /* A damaged browser cache must not prevent opening the canvas. */ }
  return defaultLibrary()
}
