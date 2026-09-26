import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectRegistry } from './lib/project-registry.mjs'
import { createBoardStore } from './lib/board-store.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'canvas-boards-test-'))
  const registry = createProjectRegistry({ dataRoot: join(root, 'data'), excludeFromGit: async () => {} })
  for (const dir of ['A', 'B']) await mkdir(join(root, dir))
  const a = await registry.registerDirectory(join(root, 'A'))
  const b = await registry.registerDirectory(join(root, 'B'))
  let time = Date.now()
  const options = { registry, dataRoot: join(root, 'data'), now: () => time }
  const store = createBoardStore(options)
  time += 21_000
  return { root, a, b, store, options, advance: ms => { time += ms } }
}
const scene = { type: 'excalidraw', version: 2, source: 'test', elements: [{ id: 'shape', type: 'rectangle' }], appState: {}, files: {} }

test('stable conversation boards coexist across projects and chats, secrets stay out of history', async () => {
  const { a, b, store } = await fixture()
  const one = await store.open({ projectId: a.id, conversation: 'codex:chat-a' })
  const again = await store.open({ projectId: a.id, conversation: 'codex:chat-a' })
  const other = await store.open({ projectId: a.id, conversation: 'opencode:chat-b' })
  const across = await store.open({ projectId: b.id, conversation: 'codex:chat-a' })
  assert.equal(one.board.id, again.board.id)
  assert.notEqual(one.board.id, other.board.id); assert.notEqual(one.board.id, across.board.id)
  assert(!JSON.stringify(await store.list()).includes(one.receiverToken))
  await assert.rejects(store.open({ projectId: a.id, boardId: one.board.id, conversation: 'other' }), { code: 'BINDING_CONFLICT' })
})

test('same-board save conflicts preserve recovery; separate boards do not interfere', async () => {
  const { a, store } = await fixture()
  const first = await store.open({ projectId: a.id }); const second = await store.open({ projectId: a.id })
  const results = await Promise.allSettled([
    store.save(first.board.id, { scene, baseRevision: 0 }),
    store.save(first.board.id, { scene: { ...scene, elements: [] }, baseRevision: 0 }),
  ])
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1)
  const failure = results.find(x => x.status === 'rejected')
  assert(failure.reason.recoveryPath)
  assert((await readFile(failure.reason.recoveryPath)).length)
  await store.save(second.board.id, { scene, baseRevision: 0 })
  assert.equal((await store.load(first.board.id)).revision, 1)
  assert((await store.previewTrash(first.board.id)).protectedReasons.includes('有未解决的冲突副本'))
})

test('durable delivery retries, cross-board auth, renewal and stale claim fencing', async () => {
  const f = await fixture(); const { a, store } = f
  const { board, receiverToken } = await store.open({ projectId: a.id, conversation: 'codex:test' })
  await store.save(board.id, { scene, baseRevision: 0 })
  const submission = { clientSubmissionId: 'test-submission-1', note: 'inspect', sceneRevision: 1 }
  await store.submit(board.id, submission); await store.submit(board.id, submission)
  assert.equal((await store.status(board.id)).pending, 1)
  await assert.rejects(store.receive(board.id, 'other'), { code: 'UNAUTHORIZED' })
  const received = await store.receive(board.id, receiverToken)
  assert.equal((await store.receive(board.id, receiverToken)).claimToken, received.claimToken)
  assert.equal((await store.receive(board.id, receiverToken, 'second-receive-attempt')).decision, 'busy')
  f.advance(121_000)
  await assert.rejects(store.transition(board.id, receiverToken, received, 'complete'), { code: 'LEASE_EXPIRED' })
  const reclaimed = await store.receive(board.id, receiverToken)
  assert.notEqual(reclaimed.claimToken, received.claimToken)
  await assert.rejects(store.transition(board.id, receiverToken, received, 'complete'), { code: 'CLAIM_MISMATCH' })
  await store.transition(board.id, receiverToken, reclaimed, 'renew')
  await store.transition(board.id, receiverToken, reclaimed, 'complete')
  await store.transition(board.id, receiverToken, reclaimed, 'complete')
  assert.equal((await store.receive(board.id, receiverToken)).decision, 'empty')
  const restart = createBoardStore(f.options)
  assert.equal((await restart.status(board.id)).receiverOnline, false)
  assert.equal((await restart.open({ projectId: a.id, conversation: 'codex:test' })).board.id, board.id)
})

test('recycle rechecks active windows, versions and jobs, restores without deleting data', async () => {
  const { a, store, advance } = await fixture()
  const { board } = await store.open({ projectId: a.id })
  await store.save(board.id, { scene, baseRevision: 0 })
  const preview = await store.previewTrash(board.id)
  await store.presence(board.id, { windowId: 'other-window', visible: true })
  await assert.rejects(store.trash(board.id, preview.revision), { code: 'BOARD_IN_USE' })
  advance(21_000)
  await assert.rejects(store.trash(board.id, preview.revision), { code: 'BOARD_IN_USE' })
  await store.releaseWindows(board.id)
  await store.update(board.id, { favorite: true })
  await assert.rejects(store.trash(board.id, preview.revision), { code: 'BOARD_CHANGED' })
  await assert.rejects(store.trash(board.id, (await store.previewTrash(board.id)).revision), { code: 'BOARD_IN_USE' })
  await store.update(board.id, { favorite: false })
  await store.trash(board.id, (await store.previewTrash(board.id)).revision)
  await assert.rejects(store.save(board.id, { scene, baseRevision: 1 }), { code: 'BOARD_TRASHED' })
  await store.restore(board.id)
  assert.deepEqual((await store.load(board.id)).scene, scene)
  await store.submit(board.id, { clientSubmissionId: 'pending-blocks-trash', sceneRevision: 1 })
  await assert.rejects(store.trash(board.id, (await store.previewTrash(board.id)).revision), { code: 'BOARD_IN_USE' })
})

test('launch handshake is board-specific and does not assert page visible before presence', async () => {
  const { a, store } = await fixture()
  const { board } = await store.open({ projectId: a.id })
  const { launchId } = await store.launch(board.id)
  assert.equal(store.launchStatus(launchId).pageVisible, false)
  await store.presence(board.id, { windowId: 'w', visible: false, launchId })
  assert.equal(store.launchStatus(launchId).pageLoaded, true)
  assert.equal(store.launchStatus(launchId).pageVisible, false)
  await store.presence(board.id, { windowId: 'w', visible: true, launchId })
  assert.equal(store.launchStatus(launchId).pageVisible, true)
})
