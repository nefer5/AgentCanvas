import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSceneStore } from './lib/scene-store.mjs'
import { writeJsonAtomic } from './lib/atomic-files.mjs'
import { previewVersions, recoverVersionRecycle } from './lib/version-recycle.mjs'
import { randomUUID } from 'node:crypto'

test('legacy version rotation preserves current, references and conflict files without deleting bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-versions-'))
  for (const dir of ['current', 'versions', 'inbox', 'processed']) await mkdir(join(root, dir))
  const project = { id: 'scratch', canvasDir: root }
  const store = createSceneStore()
  let scenePath
  const legacyScene = { elements: [{ id: 'legacy' }], appState: {}, files: {} }
  for (let i = 1; i <= 65; i++) {
    scenePath = `versions/revision-${i}-${randomUUID()}.excalidraw`
    await writeJsonAtomic(join(root, scenePath), legacyScene)
  }
  await writeJsonAtomic(join(root, 'current', 'metadata.json'), { schemaVersion: 2, revision: 65, scenePath, updatedAt: new Date().toISOString() })
  const current = await store.load(project)
  assert.equal((await store.save(project, { baseRevision: 65, scene: current.scene })).revision, 65)
  await writeJsonAtomic(join(root, 'jobs.json'), [{ sceneRevision: 1 }])
  await writeJsonAtomic(join(root, 'versions', 'conflict-test.excalidraw'), current.scene)
  const preview = await store.versions(project)
  assert.equal(preview.candidateCount, 14)
  await assert.rejects(store.versions(project, { baseRevision: preview.baseRevision }), { code: 'LEGACY_ROTATION_DISABLED' })
  assert.deepEqual((await store.load(project)).scene, current.scene)
})

test('interrupted rotation recovers before a scene load', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-versions-crash-'))
  for (const dir of ['current', 'versions', 'version-trash']) await mkdir(join(root, dir))
  const project = { id: 'scratch', canvasDir: root }; const store = createSceneStore()
  await store.save(project, { baseRevision: 0, scene: { elements: [], appState: {}, files: {} } })
  const plan = await previewVersions(root)
  const id = randomUUID()
  await writeJsonAtomic(join(root, 'version-recycle.json'), { id, state: 'pending', keep: plan.keepNames })
  await rename(join(root, 'versions'), join(root, 'version-trash', id))
  assert.equal((await store.load(project)).revision, 1)
  assert.equal(JSON.parse(await readFile(join(root, 'version-recycle.json'), 'utf8')).state, 'complete')
})
