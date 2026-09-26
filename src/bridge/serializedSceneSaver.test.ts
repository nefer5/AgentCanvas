import { describe, expect, it } from 'vitest'
import type { SceneSnapshot } from './types'
import { SerializedSceneSaver } from './serializedSceneSaver'

const scene = (id: string): SceneSnapshot => ({
  type: 'excalidraw',
  version: 2,
  source: 'http://127.0.0.1:4173',
  elements: [{ id }],
  appState: {},
  files: {},
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('SerializedSceneSaver', () => {
  it('does not create generations or writes for unchanged rerenders', async () => {
    let writes = 0
    const saver = new SerializedSceneSaver(async () => ({ revision: ++writes }))
    saver.configure('board-a', 1, scene('same'))
    saver.update(scene('same'))
    await saver.flush()
    expect(writes).toBe(0)
    expect(saver.generation).toBe(0)
  })
  it('drains the newest generation after an in-flight save using the returned revision', async () => {
    const first = deferred<{ revision: number }>()
    const second = deferred<{ revision: number }>()
    const requests: Array<{ projectId: string; scene: SceneSnapshot; baseRevision: number }> = []
    const saver = new SerializedSceneSaver((projectId, snapshot, baseRevision) => {
      requests.push({ projectId, scene: snapshot, baseRevision })
      return requests.length === 1 ? first.promise : second.promise
    })
    saver.configure('project-a', 4, null)
    saver.update(scene('one'))

    const flushing = saver.flush()
    saver.update(scene('two'))
    first.resolve({ revision: 5 })
    await Promise.resolve()

    expect(requests).toEqual([
      { projectId: 'project-a', scene: scene('one'), baseRevision: 4 },
      { projectId: 'project-a', scene: scene('two'), baseRevision: 5 },
    ])

    second.resolve({ revision: 6 })
    await flushing

    expect(saver.revision).toBe(6)
    expect(saver.savedGeneration).toBe(2)
  })

  it('shares one active flush between concurrent callers', async () => {
    const response = deferred<{ revision: number }>()
    let requests = 0
    const saver = new SerializedSceneSaver(async () => {
      requests += 1
      return response.promise
    })
    saver.configure('project-a', 0, null)
    saver.update(scene('one'))

    const first = saver.flush()
    const second = saver.flush()

    expect(first).toBe(second)
    expect(requests).toBe(1)
    response.resolve({ revision: 1 })
    await first
  })

  it('preserves the queued local generation while disk saving is paused', async () => {
    let requests = 0
    const saver = new SerializedSceneSaver(async () => {
      requests += 1
      return { revision: 1 }
    })
    saver.configure('project-a', 0, null)
    saver.update(scene('recovery'))
    saver.pause()

    await saver.flush()

    expect(requests).toBe(0)
    expect(saver.scene).toEqual(scene('recovery'))
    expect(saver.generation).toBe(1)
    expect(saver.savedGeneration).toBe(0)
  })

  it('starts clean revision and generation state when a project is configured', async () => {
    const requests: Array<{ projectId: string; baseRevision: number }> = []
    const saver = new SerializedSceneSaver(async (projectId, _snapshot, baseRevision) => {
      requests.push({ projectId, baseRevision })
      return { revision: baseRevision + 1 }
    })
    saver.configure('project-a', 8, scene('loaded-a'))
    await saver.flush()
    saver.update(scene('changed-a'))
    await saver.flush()
    saver.configure('project-b', 2, scene('loaded-b'))
    await saver.flush()

    expect(requests).toEqual([{ projectId: 'project-a', baseRevision: 8 }])
    expect(saver.projectId).toBe('project-b')
    expect(saver.revision).toBe(2)
    expect(saver.generation).toBe(0)
    expect(saver.savedGeneration).toBe(0)
  })
})
