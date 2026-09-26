import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SceneConflictError,
  createSceneStore,
  validateScene,
} from './lib/scene-store.mjs'
import { writeJsonAtomic } from './lib/atomic-files.mjs'

const scene = {
  type: 'excalidraw',
  version: 2,
  source: 'http://127.0.0.1:4173',
  elements: [{ id: 'box-1', type: 'rectangle' }],
  appState: { theme: 'light' },
  files: {},
}

async function createProject(t) {
  const canvasDir = await mkdtemp(join(tmpdir(), 'agent-canvas-scene-store-'))
  t.after(() => rm(canvasDir, { recursive: true, force: true }))
  await Promise.all(['current', 'versions'].map((name) => mkdir(join(canvasDir, name))))
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Test project',
    rootPath: canvasDir,
    canvasDir,
    available: true,
    isScratch: false,
  }
}

async function withTimeout(promise, milliseconds, message) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function createBarrierSerializer() {
  let calls = 0
  let releaseFirst
  let signalQueued
  let tail = Promise.resolve()
  const keys = []
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve })
  const bothQueued = new Promise((resolve) => { signalQueued = resolve })

  return {
    get calls() { return calls },
    get keys() { return [...keys] },
    bothQueued,
    releaseFirst,
    run(key, operation) {
      calls += 1
      keys.push(key)
      const position = calls
      const previous = tail
      const current = (async () => {
        if (position === 1) await firstReleased
        await previous
        return operation()
      })()
      tail = current.catch(() => {})
      if (calls === 2) signalQueued()
      return current
    },
  }
}

test('saves and loads a monotonically revisioned scene', async (t) => {
  const project = await createProject(t)
  const store = createSceneStore({ now: () => new Date('2026-07-12T10:00:00.000Z') })

  assert.deepEqual(await store.load(project), { scene: null, revision: 0, updatedAt: null })

  const first = await store.save(project, { scene, baseRevision: 0 })
  assert.deepEqual(first, { revision: 1, updatedAt: '2026-07-12T10:00:00.000Z' })
  assert.deepEqual(await store.load(project), { scene, revision: 1, updatedAt: first.updatedAt })

  const secondScene = { ...scene, elements: [] }
  const second = await store.save(project, { scene: secondScene, baseRevision: first.revision })
  assert.equal(second.revision, 2)
  assert.deepEqual((await store.load(project)).scene, secondScene)

  const metadata = JSON.parse(await readFile(join(project.canvasDir, 'current', 'metadata.json'), 'utf8'))
  assert.equal(metadata.schemaVersion, 3)
  assert.equal(metadata.revision, 2)
  assert.equal(metadata.updatedAt, '2026-07-12T10:00:00.000Z')
  assert.match(metadata.scenePath, /^current\/scene-[ab]\.excalidraw$/)
  assert.deepEqual(
    JSON.parse(await readFile(join(project.canvasDir, ...metadata.scenePath.split('/')), 'utf8')).scene,
    secondScene,
  )
})

test('serializes simultaneous compare-and-commit saves for the same canonical project', async (t) => {
  const project = await createProject(t)
  const serializer = createBarrierSerializer()
  const store = createSceneStore({
    now: () => new Date('2026-07-12T10:00:00.000Z'),
    serializer,
  })
  const firstScene = { ...scene, elements: [{ id: 'first', type: 'rectangle' }] }
  const secondScene = { ...scene, elements: [{ id: 'second', type: 'ellipse' }] }
  const pending = [
    store.save(project, { scene: firstScene, baseRevision: 0 }),
    store.save(project, { scene: secondScene, baseRevision: 0 }),
  ]
  t.after(() => serializer.releaseFirst())
  try {
    const reachedBarrier = await withTimeout(Promise.race([
      serializer.bothQueued.then(() => true),
      Promise.allSettled(pending).then(() => false),
    ]), 1_000, 'timed out waiting for scene saves to reach the serializer barrier')
    assert.equal(reachedBarrier, true, 'both saves must enter the same keyed serializer')
  } finally {
    serializer.releaseFirst()
  }

  const results = await Promise.allSettled(pending)
  assert.deepEqual(results.map(({ status }) => status).sort(), ['fulfilled', 'rejected'])
  const rejected = results.find(({ status }) => status === 'rejected')
  assert.equal(rejected.reason instanceof SceneConflictError, true)
  assert.equal(rejected.reason.currentRevision, 1)
  assert.equal(serializer.calls, 2)
  assert.deepEqual(serializer.keys, [`id:${project.id}`, `id:${project.id}`])
  assert.deepEqual(
    JSON.parse(await readFile(rejected.reason.recoveryPath, 'utf8')),
    results[0].status === 'rejected' ? firstScene : secondScene,
  )
  const loaded = await store.load(project)
  assert.equal(loaded.revision, 1)
  assert.deepEqual(loaded.scene, results[0].status === 'fulfilled' ? firstScene : secondScene)
})

test('canonicalizes UUID case when choosing the scene serializer key', async (t) => {
  const project = await createProject(t)
  const keys = []
  const serializer = {
    run(key, operation) {
      keys.push(key)
      return operation()
    },
  }
  const store = createSceneStore({ serializer })

  await store.save({ ...project, id: project.id.toUpperCase() }, { scene, baseRevision: 0 })
  await store.save(project, { scene: { ...scene, elements: [] }, baseRevision: 1 })

  assert.deepEqual(keys, [`id:${project.id}`, `id:${project.id}`])
})

test('cleans a failed revision and preserves the prior commit when pointer replacement fails', async (t) => {
  const project = await createProject(t)
  const pointerPath = join(project.canvasDir, 'current', 'metadata.json')
  const mirrorPath = join(project.canvasDir, 'current', 'scene.excalidraw')
  const pointerFailure = Object.assign(new Error('injected pointer replacement failure'), {
    code: 'EIO',
  })
  let failPointer = false
  const store = createSceneStore({
    now: () => new Date('2026-07-12T10:00:00.000Z'),
    writeJson: async (filePath, value) => {
      if (failPointer && filePath === pointerPath) throw pointerFailure
      return writeJsonAtomic(filePath, value)
    },
  })

  await store.save(project, { scene, baseRevision: 0 })
  const committedPointer = await readFile(pointerPath, 'utf8')
  const committedMirror = await readFile(mirrorPath, 'utf8')
  failPointer = true
  const replacement = { ...scene, elements: [{ id: 'replacement', type: 'diamond' }] }

  await assert.rejects(
    store.save(project, { scene: replacement, baseRevision: 1 }),
    (error) => error === pointerFailure,
  )

  assert.equal(await readFile(pointerPath, 'utf8'), committedPointer)
  assert.equal(await readFile(mirrorPath, 'utf8'), committedMirror)
  assert.deepEqual(await store.load(project), {
    scene,
    revision: 1,
    updatedAt: '2026-07-12T10:00:00.000Z',
  })
  assert.equal((await readdir(join(project.canvasDir, 'versions'))).length, 0)
})

test('cleans the first failed revision so metadata-less load remains empty', async (t) => {
  const project = await createProject(t)
  const pointerPath = join(project.canvasDir, 'current', 'metadata.json')
  const pointerFailure = Object.assign(new Error('injected first pointer failure'), {
    code: 'EIO',
  })
  const store = createSceneStore({
    writeJson: async (filePath, value) => {
      if (filePath === pointerPath) throw pointerFailure
      return writeJsonAtomic(filePath, value)
    },
  })

  await assert.rejects(
    store.save(project, { scene, baseRevision: 0 }),
    (error) => error === pointerFailure,
  )
  assert.deepEqual(await readdir(join(project.canvasDir, 'versions')), [])
  assert.deepEqual(await store.load(project), {
    scene: null,
    revision: 0,
    updatedAt: null,
  })
})

test('loads a legacy current scene and migrates it on the next committed save', async (t) => {
  const project = await createProject(t)
  const currentDir = join(project.canvasDir, 'current')
  await mkdir(currentDir, { recursive: true })
  await writeJsonAtomic(join(currentDir, 'scene.excalidraw'), scene)
  await writeJsonAtomic(join(currentDir, 'metadata.json'), {
    schemaVersion: 1,
    revision: 7,
    updatedAt: '2026-07-11T12:00:00.000Z',
  })
  const store = createSceneStore({ now: () => new Date('2026-07-12T10:00:00.000Z') })

  assert.deepEqual(await store.load(project), {
    scene,
    revision: 7,
    updatedAt: '2026-07-11T12:00:00.000Z',
  })

  const migratedScene = { ...scene, elements: [] }
  assert.deepEqual(
    await store.save(project, { scene: migratedScene, baseRevision: 7 }),
    { revision: 8, updatedAt: '2026-07-12T10:00:00.000Z' },
  )
  const metadata = JSON.parse(await readFile(join(currentDir, 'metadata.json'), 'utf8'))
  assert.equal(metadata.schemaVersion, 3)
  assert.equal(metadata.revision, 8)
  assert.match(metadata.scenePath, /^current\/scene-[ab]\.excalidraw$/)
  assert.deepEqual((await store.load(project)).scene, migratedScene)
})

test('rejects schema v2 metadata without a pointer instead of falling back to the mirror', async (t) => {
  const project = await createProject(t)
  const currentDir = join(project.canvasDir, 'current')
  await mkdir(currentDir, { recursive: true })
  await writeJsonAtomic(join(currentDir, 'scene.excalidraw'), scene)
  await writeJsonAtomic(join(currentDir, 'metadata.json'), {
    schemaVersion: 2,
    revision: 1,
    updatedAt: '2026-07-12T10:00:00.000Z',
  })
  const store = createSceneStore()

  await assert.rejects(
    store.load(project),
    { code: 'SCENE_CORRUPT' },
  )
})

test('treats malformed schema v2 pointers and revisions as corruption', async (t) => {
  for (const [label, mutate] of [
    ['unsupported schema', (metadata) => ({ ...metadata, schemaVersion: 99 })],
    ['missing revision', ({ revision: _revision, ...metadata }) => metadata],
    ['missing updatedAt', ({ updatedAt: _updatedAt, ...metadata }) => metadata],
    ['zero revision', (metadata) => ({ ...metadata, revision: 0 })],
    ['pointer revision mismatch', (metadata) => ({ ...metadata, revision: 2 })],
    ['non-generated pointer filename', (metadata) => ({
      ...metadata,
      scenePath: 'versions/revision-1-deadbeef.excalidraw',
    })],
  ]) {
    await t.test(label, async (t) => {
      const project = await createProject(t)
      const store = createSceneStore()
      await store.save(project, { scene, baseRevision: 0 })
      const metadataPath = join(project.canvasDir, 'current', 'metadata.json')
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
      const nextMetadata = mutate(metadata)
      if (nextMetadata.scenePath === 'versions/revision-1-deadbeef.excalidraw') {
        await writeJsonAtomic(join(project.canvasDir, ...nextMetadata.scenePath.split('/')), scene)
      }
      await writeJsonAtomic(metadataPath, nextMetadata)

      await assert.rejects(store.load(project), { code: 'SCENE_CORRUPT' })
    })
  }
})

test('rejects a committed revision file redirected to an outside target', async (t) => {
  const project = await createProject(t)
  const store = createSceneStore()
  await store.save(project, { scene, baseRevision: 0 })
  const metadata = JSON.parse(await readFile(
    join(project.canvasDir, 'current', 'metadata.json'),
    'utf8',
  ))
  const revisionPath = join(project.canvasDir, ...metadata.scenePath.split('/'))
  const externalRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-scene-outside-'))
  const externalScene = join(externalRoot, 'outside.excalidraw')
  t.after(() => rm(externalRoot, { recursive: true, force: true }))
  await writeJsonAtomic(externalScene, { ...scene, elements: [{ id: 'outside' }] })
  await rm(revisionPath)
  try {
    await symlink(externalScene, revisionPath, 'file')
  } catch (error) {
    t.skip(`file symlink creation unavailable: ${error?.code ?? error}`)
    return
  }

  await assert.rejects(store.load(project), { code: 'SCENE_CORRUPT' })
})

test('rejects redirected authoritative metadata before reading it', async (t) => {
  const project = await createProject(t)
  const store = createSceneStore()
  await store.save(project, { scene, baseRevision: 0 })
  const metadataPath = join(project.canvasDir, 'current', 'metadata.json')
  const externalRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-metadata-outside-'))
  const externalMetadata = join(externalRoot, 'metadata.json')
  t.after(() => rm(externalRoot, { recursive: true, force: true }))
  await writeFile(externalMetadata, await readFile(metadataPath))
  await rm(metadataPath)
  try {
    await symlink(externalMetadata, metadataPath, 'file')
  } catch (error) {
    t.skip(`file symlink creation unavailable: ${error?.code ?? error}`)
    return
  }

  await assert.rejects(store.load(project), { code: 'SCENE_CORRUPT' })
})

test('rejects a redirected legacy mirror instead of reading outside the project', async (t) => {
  const project = await createProject(t)
  const currentDir = join(project.canvasDir, 'current')
  await writeJsonAtomic(join(currentDir, 'metadata.json'), {
    schemaVersion: 1,
    revision: 4,
    updatedAt: '2026-07-11T12:00:00.000Z',
  })
  const externalRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-legacy-outside-'))
  const externalScene = join(externalRoot, 'legacy.excalidraw')
  t.after(() => rm(externalRoot, { recursive: true, force: true }))
  await writeJsonAtomic(externalScene, scene)
  try {
    await symlink(externalScene, join(currentDir, 'scene.excalidraw'), 'file')
  } catch (error) {
    t.skip(`file symlink creation unavailable: ${error?.code ?? error}`)
    return
  }
  const store = createSceneStore()

  await assert.rejects(store.load(project), { code: 'SCENE_CORRUPT' })
})

test('rejects a missing committed revision even when a mirror remains', async (t) => {
  const project = await createProject(t)
  const store = createSceneStore()
  await store.save(project, { scene, baseRevision: 0 })
  const metadata = JSON.parse(await readFile(
    join(project.canvasDir, 'current', 'metadata.json'),
    'utf8',
  ))
  await rm(join(project.canvasDir, ...metadata.scenePath.split('/')))

  await assert.rejects(store.load(project), { code: 'SCENE_CORRUPT' })
})

test('rejects a lone mirror when authoritative v2 metadata disappears', async (t) => {
  const project = await createProject(t)
  const store = createSceneStore()
  await store.save(project, { scene, baseRevision: 0 })
  await writeJsonAtomic(
    join(project.canvasDir, 'current', 'scene.excalidraw'),
    { ...scene, elements: [{ id: 'stale-mirror', type: 'ellipse' }] },
  )
  await rm(join(project.canvasDir, 'current', 'metadata.json'))

  await assert.rejects(store.load(project), { code: 'SCENE_CORRUPT' })
})

test('rejects committed history when metadata and the derived mirror are both absent', async (t) => {
  const project = await createProject(t)
  const mirrorPath = join(project.canvasDir, 'current', 'scene.excalidraw')
  const mirrorFailure = Object.assign(new Error('injected mirror failure'), { code: 'EIO' })
  const store = createSceneStore({
    writeJson: async (filePath, value) => {
      if (filePath === mirrorPath) throw mirrorFailure
      return writeJsonAtomic(filePath, value)
    },
  })

  await store.save(project, { scene, baseRevision: 0 })
  await rm(join(project.canvasDir, 'current', 'metadata.json'))

  await assert.rejects(store.load(project), { code: 'SCENE_CORRUPT' })
})

test('does not mistake conflict recovery files for committed revision history', async (t) => {
  const project = await createProject(t)
  await writeJsonAtomic(join(
    project.canvasDir,
    'versions',
    'conflict-20260712T100000000Z-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.excalidraw',
  ), scene)
  const store = createSceneStore()

  assert.deepEqual(await store.load(project), {
    scene: null,
    revision: 0,
    updatedAt: null,
  })
})

test('runs the project guard inside the scene transaction before any write', async (t) => {
  const project = await createProject(t)
  const guardFailure = Object.assign(new Error('project changed before scene commit'), {
    code: 'PROJECT_UNAVAILABLE',
  })
  const store = createSceneStore({
    validateProject: async () => { throw guardFailure },
  })

  await assert.rejects(
    store.save(project, { scene, baseRevision: 0 }),
    (error) => error === guardFailure,
  )
  assert.deepEqual(await readdir(join(project.canvasDir, 'current')), [])
  assert.deepEqual(await readdir(join(project.canvasDir, 'versions')), [])
})

test('preserves a recovery scene on revision conflict', async (t) => {
  const project = await createProject(t)
  const store = createSceneStore({ now: () => new Date('2026-07-12T10:00:00.000Z') })
  await store.save(project, { scene, baseRevision: 0 })
  const submittedScene = { ...scene, elements: [] }

  let conflict
  await assert.rejects(
    store.save(project, { scene: submittedScene, baseRevision: 0 }),
    (error) => {
      conflict = error
      return error instanceof SceneConflictError && error.currentRevision === 1
    },
  )

  const versions = await readdir(join(project.canvasDir, 'snapshots'))
  const recoveries = versions.filter((name) => name.startsWith('conflict-'))
  assert.equal(versions.length, 2)
  assert.equal(recoveries.length, 1)
  assert.match(recoveries[0], /^conflict-[0-2]\.json$/)
  assert.equal(conflict.recoveryPath, join(project.canvasDir, 'snapshots', recoveries[0]))
  assert.deepEqual(JSON.parse(await readFile(conflict.recoveryPath, 'utf8')), submittedScene)
  assert.deepEqual((await store.load(project)).scene, scene)
})

test('validates the required scene collections', () => {
  assert.equal(validateScene(scene), true)
  assert.equal(validateScene(null), false)
  for (const field of ['elements', 'appState', 'files']) {
    const invalid = { ...scene }
    delete invalid[field]
    assert.equal(validateScene(invalid), false, `expected missing ${field} to be invalid`)
  }
})

test('rejects invalid scenes and base revisions without writing files', async (t) => {
  const project = await createProject(t)
  const store = createSceneStore()

  await assert.rejects(
    store.save(project, { scene: { ...scene, files: null }, baseRevision: 0 }),
    { name: 'TypeError', message: 'Invalid Excalidraw scene' },
  )
  await assert.rejects(
    store.save(project, { scene, baseRevision: -1 }),
    { name: 'TypeError', message: 'baseRevision must be a non-negative integer' },
  )
  assert.deepEqual(await readdir(join(project.canvasDir, 'current')), [])
  assert.deepEqual(await readdir(join(project.canvasDir, 'versions')), [])
})
