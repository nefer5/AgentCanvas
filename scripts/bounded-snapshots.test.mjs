import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSceneStore } from './lib/scene-store.mjs'
import { saveBoundedSnapshot, snapshotUsage, SNAPSHOT_POLICY } from './lib/bounded-snapshots.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'canvas-bounded-'))
  for (const dir of ['current', 'versions']) await mkdir(join(root, dir))
  return { id: 'scratch', canvasDir: root }
}
const scene = id => ({ type: 'excalidraw', version: 2, elements: [{ id: String(id) }], appState: {}, files: {} })

test('500 rapid edits keep the latest content but produce just one minute checkpoint', async () => {
  const project = await fixture(); let time = Date.parse('2026-01-01T00:00:00Z')
  const store = createSceneStore({ now: () => new Date(time) })
  for (let i = 0; i < 500; i++) { await store.save(project, { scene: scene(i), baseRevision: i }); time += 100 }
  assert.deepEqual(await readdir(join(project.canvasDir, 'versions')), [])
  assert.equal((await readdir(join(project.canvasDir, 'current'))).length, 4)
  assert.equal((await snapshotUsage(project.canvasDir)).history, 1)
  const restarted = createSceneStore()
  const loaded = await restarted.load(project)
  assert.equal(loaded.revision, 500); assert.deepEqual(loaded.scene, scene(499))
})

test('checkpoint count stays bounded across restart and many minutes of real edits', async () => {
  const project = await fixture(); let time = Date.parse('2026-01-01T00:00:00Z')
  let store = createSceneStore({ now: () => new Date(time) })
  for (let i = 0; i < 70; i++) {
    if (i === 35) store = createSceneStore({ now: () => new Date(time) })
    await store.save(project, { scene: scene(i), baseRevision: i }); time += 61_000
  }
  assert.equal((await snapshotUsage(project.canvasDir)).history, 20)
  assert.equal((await readdir(join(project.canvasDir, 'snapshots'))).length, 20)
  assert.deepEqual((await store.load(project)).scene, scene(69))
})

test('byte budget rotates payloads rather than moving overflow into another directory', async () => {
  const project = await fixture()
  const policy = { ...SNAPSHOT_POLICY, historySlots: 5, historyBytes: 4096, intervalMs: 0 }
  for (let i = 0; i < 30; i++) await saveBoundedSnapshot(project.canvasDir, { ...scene(i), padding: 'x'.repeat(1200) }, i, new Date(1767225600000 + i * 1000).toISOString(), 'history', policy)
  const usage = await snapshotUsage(project.canvasDir, policy)
  assert(usage.bytes <= 4096); assert(usage.history <= 5)
  const names = await readdir(join(project.canvasDir, 'snapshots'))
  const physical = (await Promise.all(names.map(name => stat(join(project.canvasDir, 'snapshots', name))))).reduce((sum, item) => sum + item.size, 0)
  assert(physical <= 4096)
  assert(!(await readdir(project.canvasDir)).includes('version-trash'))
})

test('repeated stale writers retain no more than three conflict recovery slots', async () => {
  const project = await fixture(); let time = Date.parse('2026-01-01T00:00:00Z')
  const store = createSceneStore({ now: () => new Date(time++) })
  await store.save(project, { scene: scene('current'), baseRevision: 0 })
  for (let i = 0; i < 30; i++) await assert.rejects(store.save(project, { scene: scene(`conflict-${i}`), baseRevision: 0 }))
  assert.equal((await snapshotUsage(project.canvasDir)).conflicts, 3)
  assert.deepEqual((await store.load(project)).scene, scene('current'))
})
