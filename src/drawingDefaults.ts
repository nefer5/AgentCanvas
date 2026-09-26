import { FONT_FAMILY } from '@excalidraw/excalidraw'
import type { AppState } from '@excalidraw/excalidraw/types'

export const drawingDefaults = {
  currentItemStrokeColor: '#1e1e1e',
  currentItemBackgroundColor: 'transparent',
  currentItemStrokeWidth: 2,
  currentItemStrokeStyle: 'solid',
  currentItemRoughness: 0,
  currentItemOpacity: 100,
  currentItemRoundness: 'sharp',
  currentItemFontFamily: FONT_FAMILY.Nunito,
  currentItemFontSize: 16,
  currentItemTextAlign: 'center',
  currentItemArrowType: 'round',
  currentItemStartArrowhead: null,
  currentItemEndArrowhead: 'triangle',
} satisfies Partial<AppState>

// Excalidraw shares creation styles across tools. Keep each tool's choices
// separate so a thin pen does not also turn the next rectangle into a thin one.
export function createToolStyles() {
  let previous = 'selection'
  type ToolStyle = Pick<AppState, keyof typeof drawingDefaults>
  const styles = new Map<string, ToolStyle>()
  const keys = Object.keys(drawingDefaults) as (keyof typeof drawingDefaults)[]
  const drawable = new Set(['text', 'rectangle', 'diamond', 'ellipse', 'line', 'arrow', 'freedraw'])
  return (state: AppState): ToolStyle | null => {
    const tool = state.activeTool.type
    if (tool === previous) {
      if (drawable.has(tool)) {
        styles.set(tool, Object.fromEntries(keys.map((key) => [key, state[key]])) as ToolStyle)
      }
      return null
    }
    previous = tool
    if (!drawable.has(tool)) return null
    return styles.get(tool) ?? {
      ...drawingDefaults,
      currentItemStrokeWidth: tool === 'freedraw' ? 1 : 2,
    }
  }
}
