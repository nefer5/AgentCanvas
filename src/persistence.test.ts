import { describe, expect, it } from 'vitest'
import {
  loadScene,
  sanitizeScene,
  saveScene,
  STORAGE_KEY,
  storageKey,
  type SceneSnapshot,
} from './persistence'

class MemoryStorage {
  readonly values = new Map<string, string>()

  get keys() {
    return [...this.values.keys()]
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

const sceneA: SceneSnapshot = {
  type: 'excalidraw',
  version: 2,
  source: 'http://127.0.0.1:4173',
  elements: [{ id: 'box-1', type: 'rectangle' }],
  appState: { theme: 'light' },
  files: {},
}

const sceneB: SceneSnapshot = {
  ...sceneA,
  elements: [{ id: 'ellipse-1', type: 'ellipse' }],
}

describe('scene persistence', () => {
  it('round-trips a valid scene', () => {
    const storage = new MemoryStorage()

    saveScene(storage, 'project-a', sceneA)

    expect(loadScene(storage, 'project-a')).toEqual(sceneA)
    expect(storage.keys).toEqual([storageKey('project-a')])
  })

  it('isolates scenes by project id', () => {
    const storage = new MemoryStorage()

    saveScene(storage, 'project-a', sceneA)
    saveScene(storage, 'project-b', sceneB)

    expect(loadScene(storage, 'project-a')).toEqual(sceneA)
    expect(loadScene(storage, 'project-b')).toEqual(sceneB)
    expect(storage.keys).toContain('excalidraw-local-scene-v1:project-a')
    expect(storage.keys).toContain('excalidraw-local-scene-v1:project-b')
  })

  it('migrates a legacy scene to the versioned Excalidraw shape', () => {
    const legacyScene = {
      elements: [{ id: 'legacy-line', type: 'line' }],
      appState: { viewBackgroundColor: '#fff' },
      files: { 'file-1': { id: 'file-1' } },
    }

    expect(sanitizeScene(legacyScene)).toEqual({
      type: 'excalidraw',
      version: 2,
      source: 'http://127.0.0.1:4173',
      ...legacyScene,
    })
  })

  it('recovers the old unscoped scene into scratch storage only', () => {
    const storage = new MemoryStorage()
    const legacyScene = {
      elements: [{ id: 'current-drawing', type: 'diamond' }],
      appState: {},
      files: {},
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(legacyScene))

    const migrated = loadScene(storage, 'scratch')

    expect(migrated).toMatchObject({
      type: 'excalidraw',
      version: 2,
      source: 'http://127.0.0.1:4173',
      elements: legacyScene.elements,
    })
    expect(JSON.parse(storage.getItem(storageKey('scratch')) ?? 'null')).toEqual(migrated)
    expect(loadScene(storage, 'project-a')).toBeNull()
  })

  it('rejects corrupt or structurally invalid data', () => {
    expect(sanitizeScene({ elements: 'bad', appState: {}, files: {} })).toBeNull()
    expect(sanitizeScene({ ...sceneA, type: 'not-excalidraw' })).toBeNull()
    expect(sanitizeScene({ ...sceneA, version: 1 })).toBeNull()

    const storage = new MemoryStorage()
    storage.setItem(storageKey('project-a'), '{broken')

    expect(loadScene(storage, 'project-a')).toBeNull()
  })
})
