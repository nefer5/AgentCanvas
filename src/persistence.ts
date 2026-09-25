export const STORAGE_KEY = 'excalidraw-local-scene-v1'
const LEGACY_SCENE_SOURCE = 'http://127.0.0.1:4173'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface SceneSnapshot {
  type: 'excalidraw'
  version: 2
  source: string
  elements: unknown[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
}

export const storageKey = (projectId: string) => `${STORAGE_KEY}:${projectId}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function sanitizeScene(value: unknown): SceneSnapshot | null {
  if (!isRecord(value)) return null

  const scene = value as Partial<SceneSnapshot>
  if (!Array.isArray(scene.elements)) return null
  if (!isRecord(scene.appState)) return null
  if (!isRecord(scene.files)) return null
  if (scene.type !== undefined && scene.type !== 'excalidraw') return null
  if (scene.version !== undefined && scene.version !== 2) return null
  if (scene.source !== undefined && typeof scene.source !== 'string') return null

  return {
    type: 'excalidraw',
    version: 2,
    source: scene.source ?? LEGACY_SCENE_SOURCE,
    elements: scene.elements,
    appState: scene.appState,
    files: scene.files,
  }
}

function parseScene(raw: string): SceneSnapshot | null {
  try {
    return sanitizeScene(JSON.parse(raw))
  } catch {
    return null
  }
}

export function loadScene(storage: StorageLike, projectId: string): SceneSnapshot | null {
  const projectKey = storageKey(projectId)
  const raw = storage.getItem(projectKey)
  if (raw !== null) return parseScene(raw)

  if (projectId === 'scratch') {
    const legacyRaw = storage.getItem(STORAGE_KEY)
    if (legacyRaw === null) return null
    const migrated = parseScene(legacyRaw)
    if (migrated) storage.setItem(projectKey, JSON.stringify(migrated))
    return migrated
  }

  return null
}

export function saveScene(
  storage: StorageLike,
  projectId: string,
  scene: SceneSnapshot,
): void {
  storage.setItem(storageKey(projectId), JSON.stringify(scene))
}
