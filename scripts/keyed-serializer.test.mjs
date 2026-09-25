import assert from 'node:assert/strict'
import test from 'node:test'
import { KeyedSerializer } from './lib/keyed-serializer.mjs'

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

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

test('serializes operations sharing one key', async (t) => {
  const serializer = new KeyedSerializer()
  const firstEntered = deferred()
  const releaseFirst = deferred()
  const order = []
  t.after(() => releaseFirst.resolve())
  const first = serializer.run('project-a', async () => {
    order.push('first-enter')
    firstEntered.resolve()
    await releaseFirst.promise
    order.push('first-exit')
  })
  await withTimeout(firstEntered.promise, 1_000, 'first same-key operation never entered')
  const second = serializer.run('project-a', async () => {
    order.push('second-enter')
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ['first-enter'])

  releaseFirst.resolve()
  await withTimeout(Promise.all([first, second]), 1_000, 'same-key operations did not settle')
  assert.deepEqual(order, ['first-enter', 'first-exit', 'second-enter'])
})

test('cleans up a rejected key so later work can proceed', async () => {
  const serializer = new KeyedSerializer()
  const failure = new Error('injected operation failure')

  await assert.rejects(serializer.run('project-a', async () => { throw failure }), (error) => (
    error === failure
  ))
  const result = await withTimeout(
    serializer.run('project-a', async () => 'recovered'),
    1_000,
    'same key remained blocked after rejection',
  )

  assert.equal(result, 'recovered')
})

test('allows an unrelated key to progress while another key is blocked', async (t) => {
  const serializer = new KeyedSerializer()
  const firstEntered = deferred()
  const releaseFirst = deferred()
  t.after(() => releaseFirst.resolve())
  const blocked = serializer.run('project-a', async () => {
    firstEntered.resolve()
    await releaseFirst.promise
  })
  await withTimeout(firstEntered.promise, 1_000, 'blocked key never entered')

  const unrelated = await withTimeout(
    serializer.run('project-b', async () => 'independent'),
    1_000,
    'unrelated key was blocked',
  )
  assert.equal(unrelated, 'independent')

  releaseFirst.resolve()
  await withTimeout(blocked, 1_000, 'blocked key did not settle after release')
})
