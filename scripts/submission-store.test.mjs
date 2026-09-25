import test from 'node:test'
import assert from 'node:assert/strict'
import { symlinkSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createSubmissionStore } from './lib/submission-store.mjs'

const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>'
const scene = {
  type: 'excalidraw',
  version: 2,
  source: 'http://127.0.0.1:4173',
  elements: [{ id: 'box-1', type: 'rectangle' }],
  appState: { theme: 'light' },
  files: {},
}

async function readJson(pathname) {
  return JSON.parse(await readFile(pathname, 'utf8'))
}

async function createProject(t, { currentAsFile = false } = {}) {
  const canvasDir = await mkdtemp(join(tmpdir(), 'agent-canvas-submission-store-'))
  t.after(() => rm(canvasDir, { recursive: true, force: true }))
  await Promise.all(['inbox', 'processed'].map((name) => mkdir(join(canvasDir, name))))
  if (currentAsFile) await writeFile(join(canvasDir, 'current'), 'not a directory')
  else await mkdir(join(canvasDir, 'current'))
  return {
    id: 'scratch',
    name: '临时画板',
    rootPath: canvasDir,
    canvasDir,
    available: true,
    isScratch: true,
  }
}

async function createExternalDirectory(t, label) {
  const directory = await mkdtemp(join(tmpdir(), `agent-canvas-${label}-`))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'sentinel.txt'), 'do not touch')
  return directory
}

async function linkDirectory(target, linkPath) {
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

function payload(overrides = {}) {
  return {
    scene,
    svg,
    pngDataUrl,
    note: '',
    targetSessionId: null,
    sceneRevision: 3,
    ...overrides,
  }
}

test('creates a complete pending snapshot before it is claimable', async (t) => {
  const project = await createProject(t)
  const store = createSubmissionStore({
    now: () => new Date('2026-07-12T12:00:00.000Z'),
    randomId: () => 'a1b2c3',
  })

  const result = await store.create(project, payload({ note: '重点看流程' }))

  assert.equal(result.submissionId, '20260712T120000000Z-a1b2c3')
  assert.deepEqual(result, {
    submissionId: '20260712T120000000Z-a1b2c3',
    projectId: project.id,
    projectRoot: project.rootPath,
    scenePath: join(project.canvasDir, 'inbox', result.submissionId, 'scene.excalidraw'),
    svgPath: join(project.canvasDir, 'inbox', result.submissionId, 'preview.svg'),
    pngPath: join(project.canvasDir, 'inbox', result.submissionId, 'preview.png'),
    note: '重点看流程',
    status: 'pending',
  })
  assert.deepEqual(await readJson(result.scenePath), scene)
  assert.equal(await readFile(result.svgPath, 'utf8'), svg)
  assert.equal((await stat(result.pngPath)).size > 0, true)
  assert.deepEqual(await readJson(join(project.canvasDir, 'inbox', result.submissionId, 'metadata.json')), {
    schemaVersion: 1,
    submissionId: result.submissionId,
    projectId: project.id,
    sceneRevision: 3,
    status: 'pending',
    note: '重点看流程',
    createdAt: '2026-07-12T12:00:00.000Z',
    targetSessionId: null,
    receivedAt: null,
    processedAt: null,
  })
  assert.equal(await readFile(join(project.canvasDir, 'current', 'preview.svg'), 'utf8'), svg)
  assert.deepEqual(await store.listPending(project), [result])
  assert.equal((await readdir(join(project.canvasDir, '.tmp'))).length, 0)
  for (const pathname of [result.scenePath, result.svgPath, result.pngPath]) {
    assert.equal(relative(project.canvasDir, pathname).startsWith('..'), false)
  }
})

test('releases a received snapshot back to pending when delivery cannot finish', async (t) => {
  const project = await createProject(t)
  const store = createSubmissionStore({
    now: () => new Date('2026-07-12T12:00:00.000Z'),
    randomId: () => 'delivery-race',
  })
  const created = await store.create(project, payload({ targetSessionId: 'session-1' }))
  await store.markReceived(project, created.submissionId, 'session-1')

  const released = await store.release(project, created.submissionId, 'session-1')

  assert.deepEqual(released, created)
  assert.deepEqual(await store.listPending(project), [created])
  const metadata = await readJson(join(
    project.canvasDir,
    'inbox',
    created.submissionId,
    'metadata.json',
  ))
  assert.equal(metadata.status, 'pending')
  assert.equal(metadata.receivedAt, null)
  assert.equal(Object.hasOwn(metadata, 'receiverId'), false)
})

test('concurrent targeted duplicates grant exactly one broker delivery owner', async (t) => {
  const project = await createProject(t)
  const store = createSubmissionStore({
    now: () => new Date('2026-07-12T12:00:00.000Z'),
  })
  const targeted = payload({
    targetSessionId: 'session-1',
    clientSubmissionId: '20260712T120000000Z-online-atomic',
  })

  const results = await Promise.all([
    store.createForDelivery(project, targeted, 'session-1'),
    store.createForDelivery(project, targeted, 'session-1'),
  ])

  assert.equal(results.filter(({ shouldDeliver }) => shouldDeliver).length, 1)
  assert.equal(results[0].submission.submissionId, results[1].submission.submissionId)
  assert.deepEqual(results.map(({ submission }) => submission.status), ['received', 'received'])
  const metadata = await readJson(join(
    project.canvasDir,
    'inbox',
    results[0].submission.submissionId,
    'metadata.json',
  ))
  assert.equal(metadata.status, 'received')
  assert.equal(metadata.receiverId, 'session-1')
})

test('an inbox claim cannot steal an online-targeted snapshot during creation', async (t) => {
  const project = await createProject(t)
  const store = createSubmissionStore({
    now: () => new Date('2026-07-12T12:00:00.000Z'),
  })
  const targeted = payload({
    targetSessionId: 'session-1',
    clientSubmissionId: '20260712T120000000Z-online-claim-race',
  })

  const [routed, claimed] = await Promise.all([
    store.createForDelivery(project, targeted, 'session-1'),
    store.claimOldest(project, 'inbox-agent'),
  ])

  assert.equal(routed.shouldDeliver, true)
  assert.equal(routed.submission.status, 'received')
  assert.equal(claimed, null)
  assert.deepEqual(await store.listPending(project), [])
})

test('claims oldest once and moves completed work to processed', async (t) => {
  const project = await createProject(t)
  const times = [
    new Date('2026-07-12T12:00:00.000Z'),
    new Date('2026-07-12T12:01:00.000Z'),
    new Date('2026-07-12T12:02:00.000Z'),
    new Date('2026-07-12T12:03:00.000Z'),
    new Date('2026-07-12T12:04:00.000Z'),
    new Date('2026-07-12T12:05:00.000Z'),
  ]
  const ids = ['first', 'second']
  const store = createSubmissionStore({ now: () => times.shift(), randomId: () => ids.shift() })
  const first = await store.create(project, payload({ note: 'first' }))
  const second = await store.create(project, payload({ note: 'second' }))

  const firstClaim = await store.claimOldest(project, 'agent-1')
  const secondClaim = await store.claimOldest(project, 'agent-2')

  assert.equal(firstClaim.submissionId, first.submissionId)
  assert.equal(firstClaim.status, 'received')
  assert.equal(secondClaim.submissionId, second.submissionId)
  assert.equal(await store.claimOldest(project, 'agent-3'), null)
  const completed = await store.complete(project, first.submissionId)
  assert.equal(completed.status, 'processed')
  assert.equal((await stat(join(project.canvasDir, 'processed', first.submissionId))).isDirectory(), true)
  const metadata = await readJson(join(project.canvasDir, 'processed', first.submissionId, 'metadata.json'))
  assert.equal(metadata.status, 'processed')
  assert.equal(metadata.receiverId, 'agent-1')
  assert.equal(metadata.processedAt, '2026-07-12T12:05:00.000Z')
})

test('serializes concurrent claims so each pending submission is returned once', async (t) => {
  const project = await createProject(t)
  let tick = 0
  const store = createSubmissionStore({
    now: () => new Date(Date.UTC(2026, 6, 12, 12, tick++)),
    randomId: () => `claim-${tick}`,
  })
  const submissions = await Promise.all([
    store.create(project, payload({ note: 'one' })),
    store.create(project, payload({ note: 'two' })),
  ])

  const claims = await Promise.all([
    store.claimOldest(project, 'agent-1'),
    store.claimOldest(project, 'agent-2'),
    store.claimOldest(project, 'agent-3'),
  ])

  assert.deepEqual(
    claims.filter(Boolean).map(({ submissionId }) => submissionId).sort(),
    submissions.map(({ submissionId }) => submissionId).sort(),
  )
  assert.equal(claims.filter((claim) => claim === null).length, 1)
})

test('returns the same complete snapshot for a repeated client submission id in inbox or processed', async (t) => {
  const project = await createProject(t)
  let currentTime = new Date('2026-07-12T12:00:00.000Z')
  const store = createSubmissionStore({ now: () => currentTime })
  const retryPayload = payload({
    clientSubmissionId: '20260712T120000000Z-client-repeat',
  })

  const first = await store.create(project, retryPayload)
  const second = await store.create(project, { ...retryPayload, note: 'ignored retry body' })
  assert.deepEqual(second, first)
  assert.equal((await readdir(join(project.canvasDir, 'inbox'))).length, 1)

  currentTime = new Date('2026-07-12T12:01:00.000Z')
  await store.markReceived(project, first.submissionId, 'agent-1')
  currentTime = new Date('2026-07-12T12:02:00.000Z')
  const completed = await store.complete(project, first.submissionId)
  const afterCompletion = await store.create(project, retryPayload)
  assert.deepEqual(afterCompletion, completed)
  assert.equal((await readdir(join(project.canvasDir, 'processed'))).length, 1)
})

test('continues a pending uppercase-ID snapshot after project ID migration and restart', async (t) => {
  const project = {
    ...await createProject(t),
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    isScratch: false,
  }
  const createdAt = new Date('2026-07-12T12:00:00.000Z')
  const beforeRestart = createSubmissionStore({
    now: () => createdAt,
    randomId: () => 'uppercase-pending',
  })
  const created = await beforeRestart.create(project, payload())
  const metadataPath = join(
    project.canvasDir,
    'inbox',
    created.submissionId,
    'metadata.json',
  )
  const legacyMetadata = await readJson(metadataPath)
  legacyMetadata.projectId = project.id.toUpperCase()
  await writeFile(metadataPath, JSON.stringify(legacyMetadata))

  const afterRestart = createSubmissionStore({
    now: () => new Date('2026-07-12T12:01:00.000Z'),
  })
  assert.deepEqual(await afterRestart.listPending(project), [created])

  const claimed = await afterRestart.claimOldest(project, 'agent-after-restart')
  assert.equal(claimed.submissionId, created.submissionId)
  assert.equal(claimed.status, 'received')
  assert.equal((await readJson(metadataPath)).projectId, project.id)

  const completed = await afterRestart.complete(project, created.submissionId)
  assert.equal(completed.status, 'processed')
  assert.equal(await readJson(join(
    project.canvasDir,
    'processed',
    created.submissionId,
    'metadata.json',
  )).then((metadata) => metadata.projectId), project.id)
})

test('reuses an immutable processed uppercase-ID snapshot after project ID migration and restart', async (t) => {
  const project = {
    ...await createProject(t),
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    isScratch: false,
  }
  const retryPayload = payload({
    clientSubmissionId: '20260712T120000000Z-uppercase-processed',
  })
  const beforeRestart = createSubmissionStore({
    now: () => new Date('2026-07-12T12:00:00.000Z'),
  })
  const created = await beforeRestart.create(project, retryPayload)
  await beforeRestart.markReceived(project, created.submissionId, 'agent-before-restart')
  const completed = await beforeRestart.complete(project, created.submissionId)
  const metadataPath = join(
    project.canvasDir,
    'processed',
    created.submissionId,
    'metadata.json',
  )
  const legacyMetadata = await readJson(metadataPath)
  legacyMetadata.projectId = project.id.toUpperCase()
  await writeFile(metadataPath, JSON.stringify(legacyMetadata))

  const afterRestart = createSubmissionStore({
    now: () => new Date('2026-07-12T12:01:00.000Z'),
  })
  assert.deepEqual(await afterRestart.create(project, retryPayload), completed)
  assert.equal((await readJson(metadataPath)).projectId, project.id.toUpperCase())
})

test('does not accept a malformed snapshot project ID as a migration variant', async (t) => {
  const project = {
    ...await createProject(t),
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    isScratch: false,
  }
  const store = createSubmissionStore({ randomId: () => 'malformed-project-id' })
  const created = await store.create(project, payload())
  const metadataPath = join(
    project.canvasDir,
    'inbox',
    created.submissionId,
    'metadata.json',
  )
  const metadata = await readJson(metadataPath)
  metadata.projectId = 'not-a-project-id'
  await writeFile(metadataPath, JSON.stringify(metadata))

  await assert.rejects(
    store.markReceived(project, created.submissionId, 'agent-1'),
    /incomplete|invalid/i,
  )
})

test('recovers stale received submissions before listing or claiming', async (t) => {
  const project = await createProject(t)
  let currentTime = new Date('2026-07-12T12:00:00.000Z')
  const store = createSubmissionStore({ now: () => currentTime, randomId: () => 'stale' })
  const created = await store.create(project, payload())
  currentTime = new Date('2026-07-12T12:01:00.000Z')
  await store.markReceived(project, created.submissionId, 'disconnected-agent')

  currentTime = new Date('2026-07-12T13:01:00.000Z')
  assert.deepEqual(await store.listPending(project), [])
  currentTime = new Date('2026-07-12T13:01:00.001Z')
  assert.deepEqual(await store.listPending(project), [{ ...created, status: 'pending' }])
  const metadata = await readJson(join(project.canvasDir, 'inbox', created.submissionId, 'metadata.json'))
  assert.equal(metadata.status, 'pending')
  assert.equal(metadata.receivedAt, null)
  assert.equal(Object.hasOwn(metadata, 'receiverId'), false)

  currentTime = new Date('2026-07-12T13:02:00.000Z')
  assert.equal((await store.claimOldest(project, 'new-agent')).submissionId, created.submissionId)
  currentTime = new Date('2026-07-12T13:02:00.002Z')
  assert.deepEqual(await store.recoverStale(project, 1), [{ ...created, status: 'pending' }])
})

test('rejects oversized or malformed payloads before creating an inbox entry', async (t) => {
  const project = await createProject(t)
  const store = createSubmissionStore()
  const tooLargePng = `data:image/png;base64,${Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64')}`

  for (const [label, invalidPayload] of [
    ['scene', payload({ scene: { ...scene, files: null } })],
    ['note', payload({ note: 'x'.repeat(4001) })],
    ['empty svg', payload({ svg: '' })],
    ['svg', payload({ svg: 'x'.repeat(10 * 1024 * 1024 + 1) })],
    ['png type', payload({ pngDataUrl: 'data:image/jpeg;base64,AA==' })],
    ['empty png', payload({ pngDataUrl: 'data:image/png;base64,A' })],
    ['png size', payload({ pngDataUrl: tooLargePng })],
    ['scene revision', payload({ sceneRevision: -1 })],
    ['target session', payload({ targetSessionId: 42 })],
    ['client id', payload({ clientSubmissionId: '../outside' })],
  ]) {
    await assert.rejects(store.create(project, invalidPayload), undefined, label)
  }

  assert.deepEqual(await readdir(join(project.canvasDir, 'inbox')), [])
  assert.equal(await stat(join(project.canvasDir, '..', 'outside')).catch(() => null), null)
})

test('never overwrites an incomplete snapshot with a matching client submission id', async (t) => {
  const project = await createProject(t)
  const store = createSubmissionStore()
  const clientSubmissionId = '20260712T120000000Z-incomplete'
  const existing = join(project.canvasDir, 'inbox', clientSubmissionId)
  await mkdir(existing)
  await writeFile(join(existing, 'metadata.json'), 'sentinel')

  await assert.rejects(
    store.create(project, payload({ clientSubmissionId })),
    /incomplete|invalid/i,
  )
  assert.equal(await readFile(join(existing, 'metadata.json'), 'utf8'), 'sentinel')
})

test('does not list or reuse a snapshot whose metadata is incomplete', async (t) => {
  const project = await createProject(t)
  const store = createSubmissionStore()
  const clientSubmissionId = '20260712T120000000Z-invalid-metadata'
  const created = await store.create(project, payload({ clientSubmissionId }))
  const metadataPath = join(project.canvasDir, 'inbox', clientSubmissionId, 'metadata.json')
  const metadata = await readJson(metadataPath)
  delete metadata.sceneRevision
  await writeFile(metadataPath, JSON.stringify(metadata))

  assert.deepEqual(await store.listPending(project), [])
  await assert.rejects(
    store.create(project, payload({ clientSubmissionId })),
    /incomplete|invalid/i,
  )
  assert.equal((await stat(created.scenePath)).isFile(), true)
})

test('keeps the committed inbox authoritative when current preview copying fails', async (t) => {
  const project = await createProject(t, { currentAsFile: true })
  const store = createSubmissionStore({
    now: () => new Date('2026-07-12T12:00:00.000Z'),
    randomId: () => 'preview-failure',
  })

  const created = await store.create(project, payload())

  assert.equal(created.status, 'pending')
  assert.equal((await stat(created.svgPath)).isFile(), true)
  assert.equal((await stat(created.pngPath)).isFile(), true)
})

test('returns the committed snapshot when current becomes unsafe before preview setup', async (t) => {
  const project = await createProject(t)
  const external = await createExternalDirectory(t, 'late-current-redirect')
  const currentPath = join(project.canvasDir, 'current')
  await rm(currentPath, { recursive: true })
  const id = '20260712T120000000Z-late-preview-parent'
  const store = createSubmissionStore({
    now: () => new Date('2026-07-12T12:00:00.000Z'),
    randomId: () => {
      symlinkSync(external, currentPath, process.platform === 'win32' ? 'junction' : 'dir')
      return 'late-preview-parent'
    },
  })

  let created
  let failure
  try {
    created = await store.create(project, payload())
  } catch (error) {
    failure = error
  }

  assert.deepEqual(await readdir(join(project.canvasDir, 'inbox')), [id])
  assert.deepEqual((await readdir(external)).sort(), ['sentinel.txt'])
  if (failure) throw failure
  assert.equal(created.submissionId, id)
  assert.equal(created.status, 'pending')
})

test('rejects redirected managed parents before create touches external content', async (t) => {
  for (const parent of ['.tmp', 'inbox', 'current']) {
    await t.test(parent, async (t) => {
      const project = await createProject(t)
      const external = await createExternalDirectory(t, `${parent.slice(1) || 'tmp'}-redirect`)
      const managedParent = join(project.canvasDir, parent)
      await rm(managedParent, { recursive: true, force: true })
      await linkDirectory(external, managedParent)
      const store = createSubmissionStore({
        now: () => new Date('2026-07-12T12:00:00.000Z'),
        randomId: () => 'redirect-parent',
      })

      await assert.rejects(store.create(project, payload()), /symlink|junction|outside|managed/i)

      assert.equal(await readFile(join(external, 'sentinel.txt'), 'utf8'), 'do not touch')
      assert.deepEqual((await readdir(external)).sort(), ['sentinel.txt'])
    })
  }
})

test('rejects a redirected per-submission temp path before recursive cleanup', async (t) => {
  const project = await createProject(t)
  const external = await createExternalDirectory(t, 'submission-temp-redirect')
  const id = '20260712T120000000Z-redirect-temp'
  await mkdir(join(project.canvasDir, '.tmp'))
  await linkDirectory(external, join(project.canvasDir, '.tmp', id))
  const store = createSubmissionStore({
    now: () => new Date('2026-07-12T12:00:00.000Z'),
    randomId: () => 'redirect-temp',
  })

  await assert.rejects(store.create(project, payload()), /symlink|junction|outside|submission/i)

  assert.equal(await readFile(join(external, 'sentinel.txt'), 'utf8'), 'do not touch')
  assert.deepEqual((await readdir(external)).sort(), ['sentinel.txt'])
})

test('rejects a redirected processed parent before completion mutates either location', async (t) => {
  const project = await createProject(t)
  const external = await createExternalDirectory(t, 'processed-redirect')
  const store = createSubmissionStore({
    now: () => new Date('2026-07-12T12:00:00.000Z'),
    randomId: () => 'complete-redirect',
  })
  const created = await store.create(project, payload())
  await store.markReceived(project, created.submissionId, 'agent-1')
  await rm(join(project.canvasDir, 'processed'), { recursive: true, force: true })
  await linkDirectory(external, join(project.canvasDir, 'processed'))

  await assert.rejects(store.complete(project, created.submissionId), /symlink|junction|outside|managed/i)

  assert.equal(await readFile(join(external, 'sentinel.txt'), 'utf8'), 'do not touch')
  assert.deepEqual((await readdir(external)).sort(), ['sentinel.txt'])
  assert.equal((await readJson(join(project.canvasDir, 'inbox', created.submissionId, 'metadata.json'))).status, 'received')
})

test('rejects traversal IDs and invalid completion transitions', async (t) => {
  const project = await createProject(t)
  const store = createSubmissionStore({ randomId: () => 'safe-id' })
  const created = await store.create(project, payload())

  for (const id of ['../outside', '..\\outside', 'short', `${'x'.repeat(121)}y`]) {
    await assert.rejects(store.markReceived(project, id, 'agent-1'), { name: 'TypeError' })
    await assert.rejects(store.complete(project, id), { name: 'TypeError' })
  }
  await assert.rejects(store.complete(project, created.submissionId), /received/i)
  assert.equal((await stat(join(project.canvasDir, 'inbox', created.submissionId))).isDirectory(), true)
})
