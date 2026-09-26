import { convertToExcalidrawElements, restoreLibraryItems } from '@excalidraw/excalidraw'
import type { LibraryItems } from '@excalidraw/excalidraw/types'
import type { ExcalidrawLinearElement } from '@excalidraw/excalidraw/element/types'

export const LIBRARY_KEY = 'agentcanvas-library-v1'
const LIBRARY_DEFAULTS_KEY = 'agentcanvas-library-defaults-v2'
const COORDINATE_ID = 'agentcanvas-coordinate-system-v1'
const triangles = [
  { id: 'equilateral', name: '等边三角形', points: [[0, 104], [60, 0], [120, 104], [0, 104]] },
  { id: 'isosceles', name: '等腰三角形', points: [[0, 140], [50, 0], [100, 140], [0, 140]] },
  { id: 'right', name: '直角三角形', points: [[0, 0], [0, 100], [140, 100], [0, 0]] },
  { id: 'right-isosceles', name: '等腰直角三角形', points: [[0, 0], [0, 100], [100, 100], [0, 0]] },
  { id: 'inverted', name: '倒三角形', points: [[0, 0], [120, 0], [60, 104], [0, 0]] },
  { id: 'scalene', name: '不等边三角形', points: [[0, 100], [35, 0], [150, 100], [0, 100]] },
]

export function defaultLibrary(): LibraryItems {
  const items = triangles.map(({ id, name, points }) => ({
    id: `agentcanvas-triangle-${id}-v1`,
    name,
    status: 'unpublished' as const,
    created: 0,
    elements: convertToExcalidrawElements([{
      type: 'line', x: 0, y: 0,
      points: points as ExcalidrawLinearElement['points'],
      roughness: 0, roundness: null, strokeWidth: 2,
      strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
      startArrowhead: null, endArrowhead: null,
    }]),
  }))
  const axisStyle = {
    strokeColor: '#1e1e1e', strokeWidth: 2, roughness: 0,
    roundness: null, startArrowhead: null, endArrowhead: 'triangle' as const,
  }
  items.push({
    id: COORDINATE_ID, name: '平面直角坐标系', status: 'unpublished', created: 0,
    elements: convertToExcalidrawElements([
      { type: 'arrow', x: 0, y: 160, points: [[0, 0], [280, 0]], ...axisStyle },
      { type: 'arrow', x: 60, y: 220, points: [[0, 0], [0, -220]], ...axisStyle },
      { type: 'text', x: 285, y: 166, text: 'x', fontSize: 16, fontFamily: 6 },
      { type: 'text', x: 40, y: 0, text: 'y', fontSize: 16, fontFamily: 6 },
      { type: 'text', x: 40, y: 166, text: 'O', fontSize: 16, fontFamily: 6 },
    ]).map((element) => ({ ...element, groupIds: [COORDINATE_ID] })),
  })
  return restoreLibraryItems(items, 'unpublished')
}

export function loadLibrary(): LibraryItems {
  try {
    const saved = window.localStorage.getItem(LIBRARY_KEY)
    if (saved) {
      const items = restoreLibraryItems(JSON.parse(saved), 'unpublished')
      // Add the new built-in to existing libraries without replacing user items.
      if (!window.localStorage.getItem(LIBRARY_DEFAULTS_KEY)
        && !items.some((item) => item.id === COORDINATE_ID)) {
        items.push(...defaultLibrary().filter((item) => item.id === COORDINATE_ID))
      }
      return items
    }
  } catch { /* A damaged browser cache must not prevent opening the canvas. */ }
  return defaultLibrary()
}

export function saveLibrary(items: LibraryItems) {
  window.localStorage.setItem(LIBRARY_KEY, JSON.stringify(items))
  window.localStorage.setItem(LIBRARY_DEFAULTS_KEY, '1')
}
