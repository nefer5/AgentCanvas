import { exportToBlob, exportToSvg, serializeAsJSON } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { SceneSnapshot } from './types'

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('PNG 读取失败'))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(blob)
  })
}

export async function exportScene(api: ExcalidrawImperativeAPI): Promise<{
  scene: SceneSnapshot
  svg: string
  pngDataUrl: string
}> {
  const elements = api.getSceneElements()
  const appState = api.getAppState()
  const files = api.getFiles()
  const scene = JSON.parse(
    serializeAsJSON(elements, appState, files, 'local'),
  ) as SceneSnapshot
  const svg = await exportToSvg({
    elements,
    appState,
    files,
    exportPadding: 16,
  })
  const png = await exportToBlob({
    elements,
    appState,
    files,
    exportPadding: 16,
    mimeType: 'image/png',
  })
  return {
    scene,
    svg: svg.outerHTML,
    pngDataUrl: await blobToDataUrl(png),
  }
}
