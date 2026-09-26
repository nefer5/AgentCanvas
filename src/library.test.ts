import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@excalidraw/excalidraw', () => ({
  convertToExcalidrawElements: (items: unknown[]) => items,
  restoreLibraryItems: (items: unknown[]) => items,
}))
import { LIBRARY_KEY, loadLibrary, saveLibrary } from './library'

afterEach(() => vi.unstubAllGlobals())
it('adds coordinates once while preserving custom items and deliberate deletions', () => {
  const cache = new Map<string, string>([[LIBRARY_KEY, JSON.stringify([{ id: 'custom', elements: [] }])]])
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
  } })
  const upgraded = loadLibrary()
  expect(upgraded.map((item) => item.id)).toEqual(['custom', 'agentcanvas-coordinate-system-v1'])
  saveLibrary(upgraded)
  expect(loadLibrary()).toHaveLength(2)
  saveLibrary(upgraded.filter((item) => item.id === 'custom'))
  expect(loadLibrary().map((item) => item.id)).toEqual(['custom'])
})
