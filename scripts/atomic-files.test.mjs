import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as atomicFiles from './lib/atomic-files.mjs'

const { writeFileAtomic } = atomicFiles

function observeChildSettlement(child) {
  return new Promise((resolve) => {
    let settled = false
    const settle = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    child.once('error', (error) => settle({ event: 'error', error }))
    child.once('exit', (code, signal) => settle({ event: 'exit', code, signal }))
    child.once('close', (code, signal) => settle({ event: 'close', code, signal }))
  })
}

async function withTimeout(promise, milliseconds, message) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds)
        timeout.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

test('renameWithRetry propagates a non-transient error without retrying', async () => {
  const failure = Object.assign(new Error('missing source'), { code: 'ENOENT' })
  let attempts = 0
  let sleeps = 0

  await assert.rejects(
    () => atomicFiles.renameWithRetry('source', 'destination', {
      renameFile: async () => {
        attempts += 1
        throw failure
      },
      sleep: async () => { sleeps += 1 },
      platform: 'win32',
      retryDelays: [10, 25],
    }),
    (error) => error === failure,
  )

  assert.equal(attempts, 1)
  assert.equal(sleeps, 0)
})

test('renameWithRetry makes the exact transient attempts before succeeding', async () => {
  const transientCodes = ['EPERM', 'EBUSY']
  const slept = []
  let attempts = 0

  await atomicFiles.renameWithRetry('source', 'destination', {
    renameFile: async () => {
      const code = transientCodes[attempts]
      attempts += 1
      if (code) throw Object.assign(new Error(code), { code })
    },
    sleep: async (milliseconds) => { slept.push(milliseconds) },
    platform: 'win32',
    retryDelays: [10, 25],
  })

  assert.equal(attempts, 3)
  assert.deepEqual(slept, [10, 25])
})

test('renameWithRetry rethrows the transient error after exhausting retries', async () => {
  const failure = Object.assign(new Error('still busy'), { code: 'EACCES' })
  const slept = []
  let attempts = 0

  await assert.rejects(
    () => atomicFiles.renameWithRetry('source', 'destination', {
      renameFile: async () => {
        attempts += 1
        throw failure
      },
      sleep: async (milliseconds) => { slept.push(milliseconds) },
      platform: 'win32',
      retryDelays: [10, 25],
    }),
    (error) => error === failure,
  )

  assert.equal(attempts, 3)
  assert.deepEqual(slept, [10, 25])
})

test('writeFileAtomic removes its temp file when replacement ultimately fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-canvas-atomic-failure-'))
  const destination = join(root, 'projects.json')
  await mkdir(destination)
  t.after(() => rm(root, { recursive: true, force: true }))

  await assert.rejects(() => writeFileAtomic(destination, 'new'))

  const leftovers = (await readdir(root)).filter((name) => (
    name.startsWith('.projects.json.') && name.endsWith('.tmp')
  ))
  assert.deepEqual(leftovers, [])
})

test('retries a transient Windows sharing violation while replacing a file', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-canvas-atomic-'))
  const destination = join(root, 'projects.json')
  const releasePath = join(root, 'release.lock')
  await writeFile(destination, 'old')

  const locker = spawn('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "$stream = [System.IO.File]::Open($env:AGENT_CANVAS_LOCK_PATH, 'Open', 'ReadWrite', 'None'); [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); while (-not (Test-Path -LiteralPath $env:AGENT_CANVAS_RELEASE_PATH)) { Start-Sleep -Milliseconds 5 }; $stream.Dispose()",
  ], {
    env: {
      ...process.env,
      AGENT_CANVAS_LOCK_PATH: destination,
      AGENT_CANVAS_RELEASE_PATH: releasePath,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const childSettlement = observeChildSettlement(locker)

  t.after(async () => {
    const cleanupErrors = []
    if (locker.exitCode === null && !locker.killed) {
      try {
        await writeFile(releasePath, 'release')
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      await withTimeout(childSettlement, 2_000, 'Timed out waiting for the file locker to exit')
    } catch (settlementError) {
      cleanupErrors.push(settlementError)
      if (locker.exitCode === null) {
        try {
          locker.kill()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      try {
        await withTimeout(
          childSettlement,
          1_000,
          'File locker did not exit after forced termination',
        )
      } catch (terminationError) {
        cleanupErrors.push(terminationError)
      }
    }
    try {
      await rm(root, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(error)
    }

    if (cleanupErrors.length === 1) throw cleanupErrors[0]
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'File locker teardown had multiple failures')
    }
  })

  const lockedSignal = new Promise((resolve, reject) => {
    let output = ''
    locker.stdout.setEncoding('utf8')
    locker.stdout.on('data', (chunk) => {
      output += chunk
      if (output.includes('LOCKED')) resolve()
    })
    void childSettlement.then((result) => {
      if (output.includes('LOCKED')) return
      if (result.event === 'error') {
        reject(result.error)
        return
      }
      reject(new Error(`File locker ${result.event} before locking (${result.code})`))
    })
  })
  // Readiness includes cold PowerShell startup on hosted Windows runners.
  // The actual locked-write and retry assertions below keep their original timings.
  await withTimeout(lockedSignal, 15_000, 'Timed out waiting for the file locker to signal LOCKED')

  let settled = false
  const completion = writeFileAtomic(destination, 'new').then(
    () => ({ status: 'fulfilled' }),
    (error) => ({ status: 'rejected', error }),
  )
  void completion.then(() => { settled = true })

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const temporary = (await readdir(root)).find((name) => name.endsWith('.tmp'))
    if (temporary) break
    if (attempt === 99) assert.fail('Atomic temp file was not created while the destination was locked')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  await new Promise((resolve) => setTimeout(resolve, 40))

  assert.equal(settled, false, 'write must remain pending while the child holds the lock')
  await writeFile(releasePath, 'release')

  const result = await completion
  if (result.status === 'rejected') throw result.error
  const childResult = await withTimeout(
    childSettlement,
    2_000,
    'Timed out waiting for the released file locker to exit',
  )
  if (childResult.event === 'error') throw childResult.error
  assert.equal(childResult.code, 0, `File locker ${childResult.event} with ${childResult.code}`)

  assert.equal(await readFile(destination, 'utf8'), 'new')
})
