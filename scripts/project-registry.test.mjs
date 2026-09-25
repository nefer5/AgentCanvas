import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { ensureGitInfoExclude } from './lib/git-exclude.mjs'
import { createProjectRegistry } from './lib/project-registry.mjs'

const execFileAsync = promisify(execFile)
const PROJECT_RECORD_FIELDS = ['available', 'canvasDir', 'id', 'isScratch', 'name', 'rootPath']
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OTHER_PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const UPPER_PROJECT_ID = OTHER_PROJECT_ID.toUpperCase()
const WORKSPACE_DIRS = ['current', 'inbox', 'processed', 'versions', 'candidates']

function recordFields(record) {
  return Object.keys(record).sort()
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

function createMutationBarrierSerializer() {
  let armed = false
  let calls = 0
  let releaseFirst = () => {}
  let signalQueued = () => {}
  let firstReleased = Promise.resolve()
  let bothQueued = Promise.resolve()
  let tail = Promise.resolve()
  let keys = []

  return {
    get calls() { return calls },
    get keys() { return [...keys] },
    get bothQueued() { return bothQueued },
    arm() {
      armed = true
      calls = 0
      keys = []
      firstReleased = new Promise((resolve) => { releaseFirst = resolve })
      bothQueued = new Promise((resolve) => { signalQueued = resolve })
      tail = Promise.resolve()
    },
    disarm() { armed = false },
    releaseFirst() { releaseFirst() },
    run(key, operation) {
      if (!armed) return operation()
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

async function createExistingProject(
  rootPath,
  projectId,
  name = 'Existing project',
  createdAt = '2026-07-12T00:00:00.000Z',
) {
  const canvasDir = join(rootPath, '.agent-canvas')
  await Promise.all(WORKSPACE_DIRS.map((directory) => (
    mkdir(join(canvasDir, directory), { recursive: true })
  )))
  await writeFile(join(canvasDir, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    projectId,
    name,
    rootPath,
    createdAt,
  }))
}

test('registers a stable project and creates its workspace', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-registry-'))
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-project-'))
  t.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(projectRoot, { recursive: true, force: true }),
  ]))
  const excluded = []
  const registry = createProjectRegistry({
    dataRoot,
    excludeFromGit: async (path) => excluded.push(path),
  })

  const first = await registry.registerDirectory(projectRoot)
  const second = await registry.registerDirectory(projectRoot)

  assert.equal(first.id, second.id)
  assert.equal(first.name, basename(projectRoot))
  assert.deepEqual(excluded, [projectRoot, projectRoot])
  for (const name of ['current', 'inbox', 'processed', 'versions', 'candidates']) {
    assert.equal((await stat(join(projectRoot, '.agent-canvas', name))).isDirectory(), true)
  }
})

test('lists scratch first and persists a renamed display name', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-registry-'))
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-project-'))
  t.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(projectRoot, { recursive: true, force: true }),
  ]))
  const registry = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })
  const project = await registry.registerDirectory(projectRoot)

  await registry.rename(project.id, '项目 A')

  const projects = await registry.list()
  assert.equal(projects[0].id, 'scratch')
  assert.equal(projects.find(({ id }) => id === project.id).name, '项目 A')
})

test('returns exactly the ProjectRecord fields from every public method', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-registry-'))
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-project-'))
  t.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(projectRoot, { recursive: true, force: true }),
  ]))
  const registry = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })

  const registered = await registry.registerDirectory(projectRoot)
  const renamed = await registry.rename(registered.id, 'Project A')
  const projects = await registry.list()
  const found = await registry.get(registered.id)

  assert.deepEqual(
    [registered, renamed, ...projects, found].map(recordFields),
    Array(projects.length + 3).fill(PROJECT_RECORD_FIELDS),
  )
})

test('rejects a missing registered project without recreating its canvas directory', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-registry-'))
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-project-'))
  t.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(projectRoot, { recursive: true, force: true }),
  ]))
  const registry = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })
  const project = await registry.registerDirectory(projectRoot)
  await rm(project.canvasDir, { recursive: true, force: true })

  await assert.rejects(
    registry.rename(project.id, 'Unavailable Project'),
    { code: 'PROJECT_UNAVAILABLE' },
  )
  await assert.rejects(registry.get(project.id), { code: 'PROJECT_UNAVAILABLE' })
  assert.equal((await registry.list()).find(({ id }) => id === project.id).available, false)
  await assert.rejects(stat(project.canvasDir), { code: 'ENOENT' })
})

test('reselecting a registered path with a deleted canvas rejects without recreating it', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-registry-'))
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-project-'))
  t.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(projectRoot, { recursive: true, force: true }),
  ]))
  const registry = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })
  const project = await registry.registerDirectory(projectRoot)
  await rm(project.canvasDir, { recursive: true, force: true })

  await assert.rejects(
    registry.registerDirectory(projectRoot),
    { code: 'PROJECT_UNAVAILABLE' },
  )
  await assert.rejects(stat(project.canvasDir), { code: 'ENOENT' })
})

test('register rejects a copied project ID while its original owner remains live', async (t) => {
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-copied-id-'))
  const dataRoot = join(sandboxRoot, 'data')
  const originalRoot = join(sandboxRoot, 'original')
  const copiedRoot = join(sandboxRoot, 'copied')
  await Promise.all([mkdir(originalRoot), mkdir(copiedRoot)])
  t.after(() => rm(sandboxRoot, { recursive: true, force: true }))
  const registry = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })
  const original = await registry.registerDirectory(originalRoot)
  await createExistingProject(copiedRoot, original.id, 'Copied project')

  await assert.rejects(
    registry.registerDirectory(copiedRoot),
    { code: 'PROJECT_RELOCATION_CONFLICT' },
  )
  const listed = await registry.list()
  assert.equal(listed.filter(({ id }) => id === original.id).length, 1)
  assert.equal(listed.find(({ id }) => id === original.id).rootPath, original.rootPath)
})

test('rejects a deleted and reused root even when its copied project ID matches', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-registry-'))
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-project-'))
  t.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(projectRoot, { recursive: true, force: true }),
  ]))
  const registry = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })
  const project = await registry.registerDirectory(projectRoot)
  await rm(projectRoot, { recursive: true, force: true })
  await mkdir(projectRoot)
  await createExistingProject(projectRoot, project.id)

  await assert.rejects(registry.get(project.id), { code: 'PROJECT_UNAVAILABLE' })
  assert.equal((await registry.list()).find(({ id }) => id === project.id).available, false)
})

test('rejects a registered root whose on-disk stable project ID changed', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-registry-'))
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-project-'))
  t.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(projectRoot, { recursive: true, force: true }),
  ]))
  const registry = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })
  const project = await registry.registerDirectory(projectRoot)
  const projectPath = join(project.canvasDir, 'project.json')
  const document = JSON.parse(await readFile(projectPath, 'utf8'))
  await writeFile(projectPath, JSON.stringify({ ...document, projectId: OTHER_PROJECT_ID }))

  await assert.rejects(registry.get(project.id), { code: 'PROJECT_ID_MISMATCH' })
  await assert.rejects(
    registry.rename(project.id, 'Must not rename'),
    { code: 'PROJECT_ID_MISMATCH' },
  )
  await assert.rejects(
    registry.registerDirectory(projectRoot),
    { code: 'PROJECT_ID_MISMATCH' },
  )
  assert.equal(JSON.parse(await readFile(projectPath, 'utf8')).projectId, OTHER_PROJECT_ID)
})

test('rejects root and managed-directory junction redirections', async (t) => {
  for (const redirected of ['root', '.agent-canvas', 'current', 'versions']) {
    await t.test(redirected, async (t) => {
      const sandboxRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-junction-'))
      const dataRoot = join(sandboxRoot, 'data')
      const projectRoot = join(sandboxRoot, 'project')
      await mkdir(projectRoot)
      t.after(() => rm(sandboxRoot, { recursive: true, force: true }))
      const registry = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })
      const project = await registry.registerDirectory(projectRoot)
      const source = redirected === 'root'
        ? projectRoot
        : redirected === '.agent-canvas'
          ? project.canvasDir
          : join(project.canvasDir, redirected)
      const target = join(sandboxRoot, `redirect-target-${redirected.replace('.', '')}`)
      await rename(source, target)
      try {
        await symlink(target, source, 'junction')
      } catch (error) {
        await rename(target, source)
        t.skip(`junction creation unavailable: ${error?.code ?? error}`)
        return
      }

      await assert.rejects(registry.get(project.id), { code: 'PROJECT_UNAVAILABLE' })
      assert.equal((await registry.list()).find(({ id }) => id === project.id).available, false)
    })
  }
})

test('replaces invalid and reserved on-disk project IDs with UUIDs', async (t) => {
  for (const [label, projectId] of [
    ['malformed', 'not-a-uuid'],
    ['empty', ''],
    ['reserved', 'scratch'],
  ]) {
    await t.test(label, async (t) => {
      const dataRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-registry-'))
      const projectRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-project-'))
      t.after(() => Promise.all([
        rm(dataRoot, { recursive: true, force: true }),
        rm(projectRoot, { recursive: true, force: true }),
      ]))
      const canvasDir = join(projectRoot, '.agent-canvas')
      await mkdir(canvasDir)
      await writeFile(join(canvasDir, 'project.json'), JSON.stringify({
        schemaVersion: 1,
        projectId,
        name: 'Imported project',
        rootPath: projectRoot,
        createdAt: '2026-07-12T00:00:00.000Z',
      }))
      const registry = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })

      const project = await registry.registerDirectory(projectRoot)
      const document = JSON.parse(await readFile(join(canvasDir, 'project.json'), 'utf8'))

      assert.match(project.id, UUID_PATTERN)
      assert.notEqual(project.id, projectId)
      assert.equal(document.projectId, project.id)
    })
  }
})

test('normalizes an imported on-disk UUID to lowercase', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-registry-'))
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-project-'))
  t.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(projectRoot, { recursive: true, force: true }),
  ]))
  await createExistingProject(projectRoot, UPPER_PROJECT_ID)
  const registry = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })

  const project = await registry.registerDirectory(projectRoot)

  assert.equal(project.id, OTHER_PROJECT_ID)
  const projectDocument = JSON.parse(await readFile(join(project.canvasDir, 'project.json'), 'utf8'))
  const registryDocument = JSON.parse(await readFile(join(dataRoot, 'projects.json'), 'utf8'))
  assert.equal(projectDocument.projectId, OTHER_PROJECT_ID)
  assert.deepEqual(registryDocument.projects.map(({ id }) => id), [OTHER_PROJECT_ID])
})

test('migrates a live legacy registry entry to lowercase ID and persisted root identity', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-registry-'))
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-project-'))
  t.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(projectRoot, { recursive: true, force: true }),
  ]))
  const initial = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })
  const project = await initial.registerDirectory(projectRoot)
  const registryPath = join(dataRoot, 'projects.json')
  const projectPath = join(project.canvasDir, 'project.json')
  const registryDocument = JSON.parse(await readFile(registryPath, 'utf8'))
  registryDocument.projects[0].id = project.id.toUpperCase()
  delete registryDocument.projects[0].rootIdentity
  await writeFile(registryPath, JSON.stringify(registryDocument))
  const projectDocument = JSON.parse(await readFile(projectPath, 'utf8'))
  await writeFile(projectPath, JSON.stringify({
    ...projectDocument,
    projectId: project.id.toUpperCase(),
  }))
  const restarted = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })

  const listed = await restarted.list()

  assert.equal(listed.filter(({ id }) => id === project.id).length, 1)
  const migratedRegistry = JSON.parse(await readFile(registryPath, 'utf8'))
  assert.equal(migratedRegistry.projects[0].id, project.id)
  assert.deepEqual(Object.keys(migratedRegistry.projects[0].rootIdentity).sort(), [
    'device',
    'inode',
  ])
  assert.equal(JSON.parse(await readFile(projectPath, 'utf8')).projectId, project.id)
})

test('deduplicates case-variant registry IDs in favor of the live valid owner', async (t) => {
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-case-dedupe-'))
  const dataRoot = join(sandboxRoot, 'data')
  const projectRoot = join(sandboxRoot, 'project')
  const missingRoot = join(sandboxRoot, 'missing-copy')
  await mkdir(projectRoot)
  t.after(() => rm(sandboxRoot, { recursive: true, force: true }))
  const initial = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })
  const project = await initial.registerDirectory(projectRoot)
  const registryPath = join(dataRoot, 'projects.json')
  const registryDocument = JSON.parse(await readFile(registryPath, 'utf8'))
  registryDocument.projects.push({
    ...registryDocument.projects[0],
    id: project.id.toUpperCase(),
    rootPath: missingRoot,
  })
  await writeFile(registryPath, JSON.stringify(registryDocument))
  const restarted = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })

  const listed = await restarted.list()

  assert.deepEqual(listed.filter(({ id }) => id !== 'scratch').map(({ id }) => id), [project.id])
  const migratedRegistry = JSON.parse(await readFile(registryPath, 'utf8'))
  assert.deepEqual(migratedRegistry.projects.map(({ id }) => id), [project.id])
  assert.equal(migratedRegistry.projects[0].rootPath, project.rootPath)
})

test('rejects irreconcilable case-variant IDs with two live owners', async (t) => {
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-case-conflict-'))
  const dataRoot = join(sandboxRoot, 'data')
  const firstRoot = join(sandboxRoot, 'first')
  const secondRoot = join(sandboxRoot, 'second')
  await Promise.all([mkdir(firstRoot), mkdir(secondRoot), mkdir(dataRoot)])
  t.after(() => rm(sandboxRoot, { recursive: true, force: true }))
  const createdAt = new Date(Date.now() + 60_000).toISOString()
  await Promise.all([
    createExistingProject(firstRoot, OTHER_PROJECT_ID, 'First', createdAt),
    createExistingProject(secondRoot, UPPER_PROJECT_ID, 'Second', createdAt),
  ])
  await writeFile(join(dataRoot, 'projects.json'), JSON.stringify({
    schemaVersion: 1,
    projects: [
      { id: OTHER_PROJECT_ID, name: 'First', rootPath: firstRoot, createdAt },
      { id: UPPER_PROJECT_ID, name: 'Second', rootPath: secondRoot, createdAt },
    ],
  }))
  const registry = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })

  await assert.rejects(registry.list(), { code: 'PROJECT_ID_CONFLICT' })
})

test('rejects a recreated legacy root with a copied ID when root identity is absent', async (t) => {
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-legacy-reused-'))
  const dataRoot = join(sandboxRoot, 'data')
  const projectRoot = join(sandboxRoot, 'project')
  await Promise.all([mkdir(projectRoot), mkdir(dataRoot)])
  t.after(() => rm(sandboxRoot, { recursive: true, force: true }))
  const createdAt = '2020-01-01T00:00:00.000Z'
  await createExistingProject(projectRoot, OTHER_PROJECT_ID, 'Copied legacy project', createdAt)
  await writeFile(join(dataRoot, 'projects.json'), JSON.stringify({
    schemaVersion: 1,
    projects: [{
      id: OTHER_PROJECT_ID,
      name: 'Copied legacy project',
      rootPath: projectRoot,
      createdAt,
    }],
  }))
  const registry = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })

  await assert.rejects(registry.get(OTHER_PROJECT_ID), { code: 'PROJECT_UNAVAILABLE' })
})

test('requires the explicit relocation handshake for an unavailable owner', async (t) => {
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-explicit-relocation-'))
  const dataRoot = join(sandboxRoot, 'data')
  const originalRoot = join(sandboxRoot, 'original')
  const relocatedRoot = join(sandboxRoot, 'relocated')
  await mkdir(originalRoot)
  t.after(() => rm(sandboxRoot, { recursive: true, force: true }))
  const registry = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })
  const original = await registry.registerDirectory(originalRoot)
  await rename(originalRoot, relocatedRoot)

  await assert.rejects(
    registry.registerDirectory(relocatedRoot),
    { code: 'PROJECT_RELOCATION_REQUIRED' },
  )
  const relocated = await registry.relocate(original.id.toUpperCase(), relocatedRoot)
  assert.equal(relocated.id, original.id)
  assert.equal(relocated.rootPath, await realpath(relocatedRoot))
})

test('serializes concurrent register mutations without losing either project', async (t) => {
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-registry-concurrent-'))
  const dataRoot = join(sandboxRoot, 'data')
  const firstRoot = join(sandboxRoot, 'first')
  const secondRoot = join(sandboxRoot, 'second')
  await Promise.all([mkdir(firstRoot), mkdir(secondRoot)])
  t.after(() => rm(sandboxRoot, { recursive: true, force: true }))
  const mutationSerializer = createMutationBarrierSerializer()
  mutationSerializer.arm()
  const registry = createProjectRegistry({
    dataRoot,
    excludeFromGit: async () => {},
    mutationSerializer,
  })
  const pending = [
    registry.registerDirectory(firstRoot),
    registry.registerDirectory(secondRoot),
  ]
  t.after(() => mutationSerializer.releaseFirst())
  try {
    const reachedBarrier = await withTimeout(Promise.race([
      mutationSerializer.bothQueued.then(() => true),
      Promise.allSettled(pending).then(() => false),
    ]), 1_000, 'timed out waiting for concurrent registrations to reach the barrier')
    assert.equal(reachedBarrier, true, 'both registrations must use the registry serializer')
  } finally {
    mutationSerializer.releaseFirst()
  }
  const registered = await Promise.all(pending)

  assert.equal(mutationSerializer.calls, 2)
  assert.deepEqual(mutationSerializer.keys, ['registry', 'registry'])
  mutationSerializer.disarm()
  const ids = new Set((await registry.list()).map(({ id }) => id))
  assert.equal(ids.has(registered[0].id), true)
  assert.equal(ids.has(registered[1].id), true)
})

test('serializes concurrent register and rename mutations without losing either update', async (t) => {
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-registry-concurrent-'))
  const dataRoot = join(sandboxRoot, 'data')
  const firstRoot = join(sandboxRoot, 'first')
  const secondRoot = join(sandboxRoot, 'second')
  await Promise.all([mkdir(firstRoot), mkdir(secondRoot)])
  t.after(() => rm(sandboxRoot, { recursive: true, force: true }))
  const mutationSerializer = createMutationBarrierSerializer()
  const registry = createProjectRegistry({
    dataRoot,
    excludeFromGit: async () => {},
    mutationSerializer,
  })
  const first = await registry.registerDirectory(firstRoot)
  mutationSerializer.arm()
  const pending = [
    registry.registerDirectory(secondRoot),
    registry.rename(first.id, 'Renamed while registering'),
  ]
  t.after(() => mutationSerializer.releaseFirst())
  try {
    const reachedBarrier = await withTimeout(Promise.race([
      mutationSerializer.bothQueued.then(() => true),
      Promise.allSettled(pending).then(() => false),
    ]), 1_000, 'timed out waiting for register and rename to reach the barrier')
    assert.equal(reachedBarrier, true, 'register and rename must use the registry serializer')
  } finally {
    mutationSerializer.releaseFirst()
  }
  const [second, renamed] = await Promise.all(pending)

  assert.equal(renamed.name, 'Renamed while registering')
  assert.deepEqual(mutationSerializer.keys, ['registry', 'registry'])
  mutationSerializer.disarm()
  const projects = await registry.list()
  assert.equal(projects.find(({ id }) => id === first.id).name, 'Renamed while registering')
  assert.equal(projects.some(({ id }) => id === second.id), true)
})

test('relocates an existing project without leaving a stale registry pointer', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-registry-'))
  const originalRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-project-'))
  const relocationRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-relocation-'))
  const relocatedRoot = join(relocationRoot, 'relocated-project')
  t.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(originalRoot, { recursive: true, force: true }),
    rm(relocationRoot, { recursive: true, force: true }),
  ]))
  const registry = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })
  const original = await registry.registerDirectory(originalRoot)
  await rename(originalRoot, relocatedRoot)

  const relocated = await registry.relocate(original.id, relocatedRoot)

  const canonicalRoot = await realpath(relocatedRoot)
  const projectDocument = JSON.parse(await readFile(join(relocated.canvasDir, 'project.json'), 'utf8'))
  const registryDocument = JSON.parse(await readFile(join(dataRoot, 'projects.json'), 'utf8'))
  assert.equal(relocated.id, original.id)
  assert.equal(projectDocument.rootPath, canonicalRoot)
  assert.equal(registryDocument.projects.length, 1)
  assert.equal(registryDocument.projects[0].id, original.id)
  assert.equal(registryDocument.projects[0].rootPath, canonicalRoot)
  assert.equal(registryDocument.projects.some(({ rootPath }) => rootPath === original.rootPath), false)
  assert.deepEqual(recordFields(relocated), PROJECT_RECORD_FIELDS)
})

test('rejects relocation when the candidate on-disk project ID does not match', async (t) => {
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-relocation-invalid-'))
  const dataRoot = join(sandboxRoot, 'data')
  const originalRoot = join(sandboxRoot, 'original')
  const candidateRoot = join(sandboxRoot, 'candidate')
  await Promise.all([mkdir(originalRoot), mkdir(candidateRoot)])
  t.after(() => rm(sandboxRoot, { recursive: true, force: true }))
  const registry = createProjectRegistry({ dataRoot, excludeFromGit: async () => {} })
  const original = await registry.registerDirectory(originalRoot)
  await createExistingProject(candidateRoot, OTHER_PROJECT_ID)

  await assert.rejects(
    registry.relocate(original.id, candidateRoot),
    { code: 'PROJECT_ID_MISMATCH' },
  )
  assert.equal((await registry.get(original.id)).rootPath, await realpath(originalRoot))
  const registryDocument = JSON.parse(await readFile(join(dataRoot, 'projects.json'), 'utf8'))
  assert.equal(registryDocument.projects.find(({ id }) => id === original.id).rootPath, original.rootPath)
})

test('adds a project-local Git exclusion idempotently', async (t) => {
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-git-exclude-'))
  const projectRoot = join(sandboxRoot, 'project')
  const unrelatedCwd = join(sandboxRoot, 'cwd')
  t.after(() => rm(sandboxRoot, { recursive: true, force: true }))
  await mkdir(unrelatedCwd)
  await execFileAsync('git', ['init', projectRoot])

  const originalCwd = process.cwd()
  process.chdir(unrelatedCwd)
  try {
    assert.equal(await ensureGitInfoExclude(projectRoot), true)
    assert.equal(await ensureGitInfoExclude(projectRoot), false)
  } finally {
    process.chdir(originalCwd)
  }

  const exclude = await readFile(join(projectRoot, '.git', 'info', 'exclude'), 'utf8')
  assert.equal(exclude.split(/\r?\n/).filter((line) => line === '/.agent-canvas/').length, 1)
})

test('anchors and escapes nested Git exclusions without touching .gitignore', async (t) => {
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-git-metachar-'))
  const repositoryRoot = join(sandboxRoot, 'repository')
  const projectRoot = join(repositoryRoot, '#notes', '!draft', 'work[1]')
  const ignoredFile = join(projectRoot, '.agent-canvas', 'scene.excalidraw')
  t.after(() => rm(sandboxRoot, { recursive: true, force: true }))
  await execFileAsync('git', ['init', repositoryRoot])
  await mkdir(join(projectRoot, '.agent-canvas'), { recursive: true })
  await writeFile(ignoredFile, '{}\n')
  const gitignorePath = join(repositoryRoot, '.gitignore')
  await writeFile(gitignorePath, 'tracked-sentinel\n')

  assert.equal(await ensureGitInfoExclude(projectRoot), true)
  assert.equal(await ensureGitInfoExclude(projectRoot), false)

  await execFileAsync('git', [
    '-C', repositoryRoot, 'check-ignore', '--quiet', '--',
    '#notes/!draft/work[1]/.agent-canvas/scene.excalidraw',
  ])
  assert.equal(await readFile(gitignorePath, 'utf8'), 'tracked-sentinel\n')
  const exclude = await readFile(join(repositoryRoot, '.git', 'info', 'exclude'), 'utf8')
  const expectedRule = '/\\#notes/\\!draft/work\\[1\\]/.agent-canvas/'
  assert.equal(exclude.split(/\r?\n/).filter((line) => line === expectedRule).length, 1)
})

test('adds the exclusion through a real linked Git worktree', async (t) => {
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'agent-canvas-git-worktree-'))
  const mainRoot = join(sandboxRoot, 'main')
  const worktreeRoot = join(sandboxRoot, 'linked')
  t.after(() => rm(sandboxRoot, { recursive: true, force: true }))
  await execFileAsync('git', ['init', mainRoot])
  await execFileAsync('git', ['-C', mainRoot, 'config', 'user.email', 'agent-canvas@example.invalid'])
  await execFileAsync('git', ['-C', mainRoot, 'config', 'user.name', 'Agent Canvas Test'])
  await writeFile(join(mainRoot, 'tracked.txt'), 'tracked\n')
  await execFileAsync('git', ['-C', mainRoot, 'add', 'tracked.txt'])
  await execFileAsync('git', ['-C', mainRoot, 'commit', '-m', 'test fixture'])
  await execFileAsync('git', ['-C', mainRoot, 'worktree', 'add', '--detach', worktreeRoot])

  assert.equal((await stat(join(worktreeRoot, '.git'))).isFile(), true)
  assert.equal(await ensureGitInfoExclude(worktreeRoot), true)
  assert.equal(await ensureGitInfoExclude(worktreeRoot), false)

  const gitPath = (await execFileAsync(
    'git', ['-C', worktreeRoot, 'rev-parse', '--git-path', 'info/exclude'],
  )).stdout.trim()
  const exclude = await readFile(resolve(worktreeRoot, gitPath), 'utf8')
  assert.equal(exclude.split(/\r?\n/).filter((line) => line === '/.agent-canvas/').length, 1)
})
