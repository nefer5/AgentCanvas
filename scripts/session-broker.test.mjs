import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SessionBroker } from './lib/session-broker.mjs'

const execFileAsync = promisify(execFile)
const PUBLIC_SESSION_FIELDS = ['createdAt', 'expiresAt', 'id', 'label', 'projectId']

function fields(value) {
  return Object.keys(value).sort()
}

test('routes one submission only to its project and hides the token', async () => {
  const broker = new SessionBroker({
    now: () => new Date('2026-07-12T12:00:00.000Z'),
    randomToken: () => 'secret-token',
  })
  const session = broker.register({
    projectId: 'project-a',
    label: 'Codex 登录讨论',
    timeoutMs: 5000,
  })

  assert.deepEqual(fields(session), [...PUBLIC_SESSION_FIELDS, 'token'].sort())
  assert.equal(session.token, 'secret-token')
  assert.deepEqual(fields(broker.list('project-a')[0]), PUBLIC_SESSION_FIELDS)
  assert.equal(broker.list('project-a')[0].token, undefined)
  assert.deepEqual(broker.list('project-b'), [])
  assert.equal(broker.deliver('project-b', session.id, { submissionId: 'wrong' }), false)

  const waiting = broker.wait(session.id, session.token)
  assert.equal(broker.deliver('project-a', session.id, { submissionId: 'right' }), true)
  assert.equal(broker.deliver('project-a', session.id, { submissionId: 'duplicate' }), false)
  assert.deepEqual(await waiting, { decision: 'submitted', submissionId: 'right' })
  assert.deepEqual(broker.list('project-a'), [])
  assert.equal(broker.has('project-a', session.id), false)
  await assert.rejects(broker.wait(session.id, session.token), { code: 'NOT_FOUND' })
})

test('buffers a delivery until the matching waiter attaches', async () => {
  const broker = new SessionBroker({ randomToken: () => 'buffer-token' })
  const session = broker.register({ projectId: 'project-a', label: 'Codex', timeoutMs: 5000 })

  assert.equal(broker.deliver('project-a', session.id, { submissionId: 'buffered' }), true)
  assert.deepEqual(broker.list('project-a'), [])
  assert.equal(broker.has('project-a', session.id), false)
  assert.deepEqual(await broker.wait(session.id, session.token), {
    decision: 'submitted',
    submissionId: 'buffered',
  })
  assert.equal(broker.deliver('project-a', session.id, { submissionId: 'late' }), false)
  await assert.rejects(broker.wait(session.id, session.token), { code: 'NOT_FOUND' })
})

test('authenticates waiters and allows only one attached waiter', async () => {
  const broker = new SessionBroker({ randomToken: () => 'correct-token' })
  const session = broker.register({ projectId: 'project-a', label: 'Codex', timeoutMs: 5000 })

  await assert.rejects(broker.wait(session.id, 'wrongly-token'), { code: 'UNAUTHORIZED' })
  await assert.rejects(broker.wait(session.id, 'short'), { code: 'UNAUTHORIZED' })
  assert.equal(broker.has('project-a', session.id), true)

  const waiting = broker.wait(session.id, session.token)
  await assert.rejects(broker.wait(session.id, session.token), { code: 'ALREADY_WAITING' })
  assert.equal(broker.deliver('project-a', session.id, { submissionId: 'authenticated' }), true)
  assert.deepEqual(await waiting, {
    decision: 'submitted',
    submissionId: 'authenticated',
  })
})

test('cancels once, authenticates the caller, and resolves an attached waiter', async () => {
  const broker = new SessionBroker({ randomToken: () => 'cancel-token' })
  const session = broker.register({ projectId: 'project-a', label: 'Codex', timeoutMs: 5000 })

  assert.throws(() => broker.cancel(session.id, 'wrong-token!'), { code: 'UNAUTHORIZED' })
  assert.equal(broker.has('project-a', session.id), true)

  const waiting = broker.wait(session.id, session.token)
  assert.equal(broker.cancel(session.id, session.token), true)
  assert.equal(broker.cancel(session.id, session.token), false)
  assert.deepEqual(await waiting, { decision: 'dismissed' })
  assert.deepEqual(broker.list('project-a'), [])
  assert.equal(broker.has('project-a', session.id), false)
})

test('buffers cancellation until wait attaches', async () => {
  const broker = new SessionBroker({ randomToken: () => 'cancel-token' })
  const session = broker.register({ projectId: 'project-a', label: 'Codex', timeoutMs: 5000 })

  assert.equal(broker.cancel(session.id, session.token), true)
  assert.deepEqual(broker.list('project-a'), [])
  assert.deepEqual(await broker.wait(session.id, session.token), { decision: 'dismissed' })
  await assert.rejects(broker.wait(session.id, session.token), { code: 'NOT_FOUND' })
})

test('returns a timeout decision and removes the session', async () => {
  const broker = new SessionBroker()
  const session = broker.register({ projectId: 'project-a', label: 'Codex', timeoutMs: 20 })

  assert.deepEqual(await broker.wait(session.id, session.token), { decision: 'timeout' })
  assert.deepEqual(broker.list('project-a'), [])
  assert.equal(broker.has('project-a', session.id), false)
  assert.equal(broker.cancel(session.id, session.token), false)
})

test('validates registration and returns isolated public snapshots', () => {
  const broker = new SessionBroker({
    now: () => new Date('2026-07-12T12:00:00.000Z'),
    randomToken: () => 'snapshot-token',
  })

  assert.throws(() => broker.register({ label: 'Codex', timeoutMs: 5000 }), { name: 'TypeError' })
  for (const timeoutMs of [9, 3_600_001, 20.5]) {
    assert.throws(
      () => broker.register({ projectId: 'project-a', label: 'Codex', timeoutMs }),
      { name: 'TypeError' },
    )
  }

  const session = broker.register({ projectId: 'project-a', label: '', timeoutMs: 5000 })
  assert.equal(session.label, 'Codex')
  assert.equal(session.createdAt, '2026-07-12T12:00:00.000Z')
  assert.equal(session.expiresAt, '2026-07-12T12:00:05.000Z')
  const listed = broker.list('project-a')[0]
  listed.label = 'mutated'
  assert.equal(broker.list('project-a')[0].label, 'Codex')
  broker.cancel(session.id, session.token)
})

test('registration timeout does not keep a Node process alive', async () => {
  await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { SessionBroker } from './scripts/lib/session-broker.mjs'
     new SessionBroker().register({ projectId: 'project-a', label: 'Codex', timeoutMs: 3_600_000 })`,
  ], { timeout: 2000, windowsHide: true })
})

test('buffer cleanup timeout does not keep a Node process alive', async () => {
  await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { SessionBroker } from './scripts/lib/session-broker.mjs'
     const broker = new SessionBroker()
     const session = broker.register({ projectId: 'project-a', label: 'Codex', timeoutMs: 3_600_000 })
     broker.deliver('project-a', session.id, { submissionId: 'buffered' })`,
  ], { timeout: 2000, windowsHide: true })
})
